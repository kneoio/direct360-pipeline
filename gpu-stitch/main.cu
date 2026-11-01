// GoPro MAX `.360` to equirectangular HEVC, all on an NVIDIA GPU: NVDEC decodes both lenses,
// a CUDA kernel blends and projects them, NVENC encodes. Frames stay in GPU memory.
//
//   gpu-stitch input.360 output.mp4 [seconds] [cq]
#include <cuda_runtime.h>
#include <deque>
#include <sys/resource.h>
#include <chrono>
#include <cstring>
#include "lut.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
}

// hwcontext_cuda.h clashes with cuda.h. This flag makes the device use the CUDA context already current here.
static const int USE_CURRENT_CONTEXT = 1 << 1;

#define CHECK(call)                                                       \
  do {                                                                    \
    int err_ = (call);                                                    \
    if (err_ < 0) {                                                       \
      char msg_[128];                                                     \
      av_strerror(err_, msg_, sizeof msg_);                               \
      throw std::runtime_error(std::string(#call ": ") + msg_);           \
    }                                                                     \
  } while (0)
#define CUDA(call)                                                        \
  do {                                                                    \
    cudaError_t err_ = (call);                                            \
    if (err_ != cudaSuccess) throw std::runtime_error(std::string(#call ": ") + cudaGetErrorString(err_)); \
  } while (0)

struct Plane {
  const uint8_t *p[2];  // one per lens
  int pitch[2];
  int w, h;
  float maxv;
  bool wide;  // 16 bits per sample, value in the high bits
};

template <typename T>
__host__ __device__ inline T clampTo(T v, T lo, T hi) { return v < lo ? lo : v > hi ? hi : v; }

// `step` 1 reads luma, 2 reads one component of interleaved chroma.
__device__ inline float readAt(const Plane &pl, int lens, int x, int y, int step, int comp) {
  x = clampTo(x, 0, pl.w - 1);
  y = clampTo(y, 0, pl.h - 1);
  const uint8_t *row = pl.p[lens] + (size_t)y * pl.pitch[lens];
  int i = x * step + comp;
  return pl.wide ? (float)(((const uint16_t *)row)[i] >> 6) : (float)row[i];
}

__device__ inline float cubic(float a, float b, float c, float d, float t) {
  return b + 0.5f * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}

__device__ inline float bicubicAt(const Plane &pl, int lens, float x, float y) {
  int i = (int)floorf(x), j = (int)floorf(y);
  float u = x - i, v = y - j, r[4];
  for (int k = 0; k < 4; k++) {
    int yy = j + k - 1;
    r[k] = cubic(readAt(pl, lens, i - 1, yy, 1, 0), readAt(pl, lens, i, yy, 1, 0),
                 readAt(pl, lens, i + 1, yy, 1, 0), readAt(pl, lens, i + 2, yy, 1, 0), u);
  }
  return cubic(r[0], r[1], r[2], r[3], v);
}

__device__ inline float bilinearAt(const Plane &pl, int lens, float x, float y, int comp) {
  int i = (int)floorf(x), j = (int)floorf(y);
  float u = x - i, v = y - j;
  float top = readAt(pl, lens, i, j, 2, comp) * (1 - u) + readAt(pl, lens, i + 1, j, 2, comp) * u;
  float bot = readAt(pl, lens, i, j + 1, 2, comp) * (1 - u) + readAt(pl, lens, i + 1, j + 1, 2, comp) * u;
  return top * (1 - v) + bot * v;
}

// A CUDA block holds at most 1024 threads.
static const int BLOCK = 32;

__global__ void lumaKernel(const Entry *lut, Plane pl, uint8_t *out, int outPitch, int ow, float gain, float lift) {
  int x = blockIdx.x * BLOCK + threadIdx.x, y = blockIdx.y * BLOCK + threadIdx.y;
  if (x >= ow || y >= gridDim.y * BLOCK) return;
  const Entry &e = lut[(size_t)y * ow + x];
  float o = bicubicAt(pl, e.lens, e.x, e.y);
  if (e.w > 0) o += (bicubicAt(pl, e.lens, e.x2, e.y) - o) * e.w;
  out[(size_t)y * outPitch + x] = (uint8_t)clampTo(o * gain + lift + 0.5f, 0.f, 255.f);
}

__global__ void chromaKernel(const Entry *lut, Plane pl, uint8_t *out, int outPitch, int cw, float gain, float center) {
  int x = blockIdx.x * BLOCK + threadIdx.x, y = blockIdx.y * BLOCK + threadIdx.y;
  if (x >= cw || y >= gridDim.y * BLOCK) return;
  const Entry &e = lut[(size_t)y * cw + x];
  for (int comp = 0; comp < 2; comp++) {
    float o = bilinearAt(pl, e.lens, e.x, e.y, comp);
    if (e.w > 0) o += (bilinearAt(pl, e.lens, e.x2, e.y, comp) - o) * e.w;
    out[(size_t)y * outPitch + x * 2 + comp] = (uint8_t)clampTo((o - center) * gain + 128.f + 0.5f, 0.f, 255.f);
  }
}

static enum AVPixelFormat pickCuda(AVCodecContext *, const enum AVPixelFormat *fmts) {
  for (; *fmts != AV_PIX_FMT_NONE; fmts++)
    if (*fmts == AV_PIX_FMT_CUDA) return *fmts;
  throw std::runtime_error("the decoder offers no CUDA output");
}

static Entry *uploadLut(const std::vector<Entry> &lut) {
  Entry *dev = nullptr;
  CUDA(cudaMalloc(&dev, lut.size() * sizeof(Entry)));
  CUDA(cudaMemcpy(dev, lut.data(), lut.size() * sizeof(Entry), cudaMemcpyHostToDevice));
  return dev;
}

int main(int argc, char **argv) try {
  if (argc < 3) {
    fprintf(stderr, "usage: gpu-stitch input.360 output.mp4 [seconds] [cq]\n");
    return 1;
  }
  const char *src = argv[1], *out = argv[2];
  double seconds = argc > 3 ? atof(argv[3]) : 0;
  const char *cq = argc > 4 ? argv[4] : "26";

  // A context current on this thread, which ffmpeg then shares.
  CUDA(cudaSetDevice(0));
  void *probe = nullptr;
  CUDA(cudaMalloc(&probe, 1));
  CUDA(cudaFree(probe));
  AVBufferRef *device = nullptr;
  CHECK(av_hwdevice_ctx_create(&device, AV_HWDEVICE_TYPE_CUDA, nullptr, nullptr, USE_CURRENT_CONTEXT));

  AVFormatContext *in = nullptr;
  CHECK(avformat_open_input(&in, src, nullptr, nullptr));
  CHECK(avformat_find_stream_info(in, nullptr));
  int lensIndex[2] = {-1, -1}, found = 0;
  for (unsigned i = 0; i < in->nb_streams && found < 2; i++) {
    AVCodecParameters *cp = in->streams[i]->codecpar;
    if (cp->codec_type == AVMEDIA_TYPE_VIDEO && cp->codec_id == AV_CODEC_ID_HEVC && cp->width > cp->height * 3) lensIndex[found++] = (int)i;
  }
  if (found != 2) throw std::runtime_error("expected two HEVC lens tracks");
  AVStream *st0 = in->streams[lensIndex[0]];
  Profile pr = profileFor(st0->codecpar->width, st0->codecpar->height);
  AVRational rate = st0->avg_frame_rate;
  long maxFrames = seconds > 0 ? lround(seconds * rate.num / rate.den) : LONG_MAX;

  AVCodecContext *dec[2];
  for (int l = 0; l < 2; l++) {
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_HEVC);
    dec[l] = avcodec_alloc_context3(codec);
    CHECK(avcodec_parameters_to_context(dec[l], in->streams[lensIndex[l]]->codecpar));
    dec[l]->hw_device_ctx = av_buffer_ref(device);
    dec[l]->get_format = pickCuda;
    dec[l]->extra_hw_frames = 8;
    dec[l]->pkt_timebase = in->streams[lensIndex[l]]->time_base;
    CHECK(avcodec_open2(dec[l], codec, nullptr));
  }

  auto t0 = std::chrono::steady_clock::now();
  std::vector<Entry> lutY = buildLut(pr, 1), lutC = buildLut(pr, 2);
  Entry *devY = uploadLut(lutY), *devC = uploadLut(lutC);
  const int ow = pr.face * 3, oh = ow / 2, cw = ow / 2, ch = oh / 2;
  printf("lut %.1fs\n", std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());

  AVBufferRef *pool = av_hwframe_ctx_alloc(device);
  AVHWFramesContext *fc = (AVHWFramesContext *)pool->data;
  fc->format = AV_PIX_FMT_CUDA;
  fc->sw_format = AV_PIX_FMT_NV12;
  fc->width = ow;
  fc->height = oh;
  fc->initial_pool_size = 8;
  CHECK(av_hwframe_ctx_init(pool));

  const AVCodec *encCodec = avcodec_find_encoder_by_name("hevc_nvenc");
  if (!encCodec) throw std::runtime_error("this ffmpeg has no hevc_nvenc");
  AVCodecContext *enc = avcodec_alloc_context3(encCodec);
  enc->width = ow;
  enc->height = oh;
  enc->pix_fmt = AV_PIX_FMT_CUDA;
  enc->hw_frames_ctx = av_buffer_ref(pool);
  enc->time_base = av_inv_q(rate);
  enc->framerate = rate;
  enc->color_range = AVCOL_RANGE_MPEG;
  enc->bit_rate = 0;
  // Without a higher cap NVENC stops at 50 Mbit/s and cq has no effect.
  enc->rc_max_rate = 400000000;
  enc->rc_buffer_size = 800000000;
  av_opt_set(enc->priv_data, "preset", "p4", 0);
  av_opt_set(enc->priv_data, "rc", "vbr", 0);
  av_opt_set(enc->priv_data, "cq", cq, 0);

  AVFormatContext *mux = nullptr;
  CHECK(avformat_alloc_output_context2(&mux, nullptr, nullptr, out));
  if (mux->oformat->flags & AVFMT_GLOBALHEADER) enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  CHECK(avcodec_open2(enc, encCodec, nullptr));
  AVStream *ost = avformat_new_stream(mux, nullptr);
  CHECK(avcodec_parameters_from_context(ost->codecpar, enc));
  ost->time_base = enc->time_base;
  ost->avg_frame_rate = rate;
  ost->codecpar->codec_tag = MKTAG('h', 'v', 'c', '1');
  CHECK(avio_open(&mux->pb, out, AVIO_FLAG_WRITE));
  CHECK(avformat_write_header(mux, nullptr));

  AVPacket *pkt = av_packet_alloc(), *outPkt = av_packet_alloc();
  auto drainEncoder = [&]() {
    for (;;) {
      int r = avcodec_receive_packet(enc, outPkt);
      if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return;
      CHECK(r);
      av_packet_rescale_ts(outPkt, enc->time_base, ost->time_base);
      outPkt->stream_index = ost->index;
      CHECK(av_interleaved_write_frame(mux, outPkt));
    }
  };

  std::deque<AVFrame *> ready[2];
  auto drainDecoder = [&](int l) {
    for (;;) {
      AVFrame *f = av_frame_alloc();
      int r = avcodec_receive_frame(dec[l], f);
      if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) { av_frame_free(&f); return; }
      CHECK(r);
      ready[l].push_back(f);
    }
  };

  auto start = std::chrono::steady_clock::now();
  long n = 0;
  bool eof = false;
  while (n < maxFrames) {
    while ((ready[0].empty() || ready[1].empty()) && !eof) {
      int r = av_read_frame(in, pkt);
      if (r == AVERROR_EOF) {
        eof = true;
        for (int l = 0; l < 2; l++) { avcodec_send_packet(dec[l], nullptr); drainDecoder(l); }
        break;
      }
      CHECK(r);
      for (int l = 0; l < 2; l++)
        if (pkt->stream_index == lensIndex[l]) { CHECK(avcodec_send_packet(dec[l], pkt)); drainDecoder(l); }
      av_packet_unref(pkt);
    }
    if (ready[0].empty() || ready[1].empty()) break;
    AVFrame *a = ready[0].front(), *b = ready[1].front();
    ready[0].pop_front();
    ready[1].pop_front();

    AVPixelFormat sw = ((AVHWFramesContext *)a->hw_frames_ctx->data)->sw_format;
    bool wide = sw != AV_PIX_FMT_NV12;
    float maxv = wide ? 1023.f : 255.f;
    bool full = a->color_range == AVCOL_RANGE_JPEG;
    float gainY = full ? 219.f / maxv : 255.f / maxv, lift = full ? 16.f : 0.f;
    float gainC = full ? 224.f / maxv : 255.f / maxv, center = wide ? 512.f : 128.f;

    AVFrame *dst = av_frame_alloc();
    CHECK(av_hwframe_get_buffer(pool, dst, 0));
    dst->pts = n;
    dst->color_range = AVCOL_RANGE_MPEG;

    Plane py{{a->data[0], b->data[0]}, {a->linesize[0], b->linesize[0]}, pr.lensW, pr.lensH, maxv, wide};
    Plane pc{{a->data[1], b->data[1]}, {a->linesize[1], b->linesize[1]}, pr.lensW / 2, pr.lensH / 2, maxv, wide};
    dim3 block(BLOCK, BLOCK);
    lumaKernel<<<dim3((ow + BLOCK - 1) / BLOCK, (oh + BLOCK - 1) / BLOCK), block>>>(devY, py, dst->data[0], dst->linesize[0], ow, gainY, lift);
    chromaKernel<<<dim3((cw + BLOCK - 1) / BLOCK, (ch + BLOCK - 1) / BLOCK), block>>>(devC, pc, dst->data[1], dst->linesize[1], cw, gainC, center);
    CUDA(cudaGetLastError());
    CUDA(cudaDeviceSynchronize());
    av_frame_free(&a);
    av_frame_free(&b);

    CHECK(avcodec_send_frame(enc, dst));
    av_frame_free(&dst);
    drainEncoder();
    n++;
  }
  CHECK(avcodec_send_frame(enc, nullptr));
  drainEncoder();
  CHECK(av_write_trailer(mux));
  avio_closep(&mux->pb);

  double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  rusage ru{};
  getrusage(RUSAGE_SELF, &ru);
  double cpu = ru.ru_utime.tv_sec + ru.ru_utime.tv_usec / 1e6 + ru.ru_stime.tv_sec + ru.ru_stime.tv_usec / 1e6;
  printf("frames %ld  wall %.1fs  %.1f fps  cpu %.0fs\n", n, wall, n / wall, cpu);
  fflush(stdout);
  // A normal return hangs in the CUDA and NVENC teardown, and the file is already closed.
  _exit(0);
} catch (const std::exception &e) {
  fprintf(stderr, "gpu-stitch: %s\n", e.what());
  return 1;
}
