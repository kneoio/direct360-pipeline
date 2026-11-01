// Lookup table for one plane: where each equirectangular pixel reads in the two lenses.
// The projection comes from ffmpeg's own v360, so the geometry matches the CPU stitch.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>
#include <unistd.h>

struct Entry {
  float x, y;  // read position in the lens, in pixels
  float x2;    // second read position across the overlap strip
  float w;     // weight of x2, 0 outside the strip
  int lens;    // 0 front, 1 back
};

struct Profile {
  int lensW, lensH, face, overlap;
  int blend() const { return overlap / 2; }
  int scaled() const { return blend() * 3 / 2; }
  int slice() const { return (face - scaled()) / 2; }
};

inline Profile profileFor(int w, int h) {
  if (w == 5952 && h == 1920) return {5952, 1920, 1920, 384};
  if (w == 4096 && h == 1344) return {4096, 1344, 1344, 128};
  throw std::runtime_error("unknown lens size " + std::to_string(w) + "x" + std::to_string(h));
}

// Runs one coordinate ramp through v360 and returns the mapped values.
inline std::vector<uint16_t> v360Ramp(const std::vector<uint16_t> &ramp, int w, int h, int ow, int oh, const char *interp) {
  char in[] = "/tmp/d360rampXXXXXX";
  int fd = mkstemp(in);
  if (fd < 0) throw std::runtime_error("cannot make a temp file");
  if (write(fd, ramp.data(), ramp.size() * 2) != (ssize_t)(ramp.size() * 2)) throw std::runtime_error("cannot write the ramp");
  close(fd);
  char cmd[600];
  snprintf(cmd, sizeof cmd,
           "ffmpeg -hide_banner -loglevel error -f rawvideo -pix_fmt gray16le -s %dx%d -i %s "
           "-vf v360=input=eac:output=equirect:interp=%s:w=%d:h=%d:yaw=0:pitch=0:roll=0 -f rawvideo -pix_fmt gray16le -",
           w, h, in, interp, ow, oh);
  FILE *p = popen(cmd, "r");
  if (!p) throw std::runtime_error("cannot start ffmpeg");
  std::vector<uint16_t> out((size_t)ow * oh);
  size_t got = fread(out.data(), 2, out.size(), p);
  pclose(p);
  unlink(in);
  if (got != out.size()) throw std::runtime_error("v360 returned a short map");
  return out;
}

// `sub` is 1 for luma and 2 for chroma.
inline std::vector<Entry> buildLut(const Profile &pr, int sub) {
  const int face = pr.face / sub, blend = pr.blend() / sub, scaled = pr.scaled() / sub, slice = pr.slice() / sub;
  const int w = face * 3, h = face * 2, ow = face * 3, oh = ow / 2;
  const float kx = 10, ky = 16;
  std::vector<uint16_t> rx((size_t)w * h), ry((size_t)w * h);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      rx[(size_t)y * w + x] = (uint16_t)(x * kx);
      ry[(size_t)y * w + x] = (uint16_t)(y * ky);
    }
  auto xl = v360Ramp(rx, w, h, ow, oh, "linear"), xn = v360Ramp(rx, w, h, ow, oh, "near");
  auto yl = v360Ramp(ry, w, h, ow, oh, "linear"), yn = v360Ramp(ry, w, h, ow, oh, "near");
  std::vector<Entry> lut((size_t)ow * oh);
  const int shift = 2 * blend - scaled;
  for (size_t i = 0; i < lut.size(); i++) {
    // Across a cube-face edge the linear ramp mixes unrelated faces, and near is right there.
    float ex = std::fabs((float)xl[i] - xn[i]) / kx > 1.5f ? xn[i] / kx : xl[i] / kx;
    float ey = std::fabs((float)yl[i] - yn[i]) / ky > 1.5f ? yn[i] / ky : yl[i] / ky;
    Entry e{};
    e.lens = ey >= face ? 1 : 0;
    e.y = e.lens ? ey - face : ey;
    float base = 0, rel = -1;
    if (ex < face) rel = ex;
    else if (ex >= 2 * face) { base = 2 * face + shift; rel = ex - 2 * face; }
    if (rel < 0) e.x = ex + shift;
    else if (rel < slice) e.x = base + rel;
    else if (rel >= slice + scaled) e.x = base + rel + shift;
    else {
      float t = (rel - slice) * blend / (float)scaled;
      e.x = base + slice + t;
      e.x2 = base + slice + blend + t;
      e.w = (t + 1) / (blend + 1);
    }
    lut[i] = e;
  }
  return lut;
}
