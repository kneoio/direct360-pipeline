// Checks the lookup table without a GPU: one stacked luma frame in, PSNR against ffmpeg's stitch of it.
//   g++ -O2 -fopenmp lut_test.cpp -o lut_test && ./lut_test lenses.y stitched.y
#include "lut.h"

static std::vector<uint8_t> src;
static Profile pr{5952, 1920, 1920, 384};

static float px(int lens, int x, int y) {
  x = x < 0 ? 0 : x >= pr.lensW ? pr.lensW - 1 : x;
  y = y < 0 ? 0 : y >= pr.lensH ? pr.lensH - 1 : y;
  return src[(size_t)(lens * pr.lensH + y) * pr.lensW + x];
}
static float cub(float a, float b, float c, float d, float t) {
  return b + 0.5f * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}
static float at(int lens, float x, float y) {
  int i = (int)std::floor(x), j = (int)std::floor(y);
  float u = x - i, v = y - j, r[4];
  for (int k = 0; k < 4; k++) r[k] = cub(px(lens, i - 1, j + k - 1), px(lens, i, j + k - 1), px(lens, i + 1, j + k - 1), px(lens, i + 2, j + k - 1), u);
  return cub(r[0], r[1], r[2], r[3], v);
}

int main(int argc, char **argv) {
  if (argc < 3) return 1;
  const int ow = pr.face * 3, oh = ow / 2;
  auto lut = buildLut(pr, 1);
  src.resize((size_t)pr.lensW * pr.lensH * 2);
  std::vector<uint8_t> want((size_t)ow * oh);
  FILE *f = fopen(argv[1], "rb");
  if (!f || fread(src.data(), 1, src.size(), f) != src.size()) return 2;
  fclose(f);
  f = fopen(argv[2], "rb");
  if (!f || fread(want.data(), 1, want.size(), f) != want.size()) return 2;
  fclose(f);
  double se = 0;
#pragma omp parallel for reduction(+ : se)
  for (long i = 0; i < (long)lut.size(); i++) {
    const Entry &e = lut[i];
    float o = at(e.lens, e.x, e.y);
    if (e.w > 0) o += (at(e.lens, e.x2, e.y) - o) * e.w;
    double d = std::round(o) - want[i];
    se += d * d;
  }
  printf("PSNR %.2f dB\n", 10 * log10(255.0 * 255.0 / (se / lut.size())));
}
