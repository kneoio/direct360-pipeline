/*
 * LD_PRELOAD for gpu-stitch. NVIDIA drivers from 570 on refuse NVENC ("unsupported
 * device") in a container given one GPU of several: the driver lists every GPU on
 * the host and the encoder fails to reach the others. This removes the GPUs whose
 * /dev/nvidiaN is not in the container from that list. If none can be matched, the
 * list stays as it was.
 *
 * A GPU id holds its PCI bus in bits 8-15; /proc/driver/nvidia/gpus/<pci>/information
 * gives the N of that bus.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define RM_CONTROL 0x2A
#define GET_ATTACHED_IDS 0x0201
#define MAX_GPUS 32
#define INVALID_ID 0xFFFFFFFFu

struct rm_control {
  uint32_t client, object, cmd, flags;
  uint32_t *params __attribute__((aligned(8)));
  uint32_t params_size, status;
};

/* The N of /dev/nvidiaN for a PCI bus, or -1. */
static int minor_of_bus(unsigned want) {
  int minor = -1;
  DIR *dir = opendir("/proc/driver/nvidia/gpus");
  if (!dir) return -1;
  struct dirent *entry;
  while (minor < 0 && (entry = readdir(dir))) {
    unsigned domain, bus, slot, func;
    if (sscanf(entry->d_name, "%x:%x:%x.%x", &domain, &bus, &slot, &func) != 4 || bus != want) continue;
    char path[512], line[256];
    snprintf(path, sizeof path, "/proc/driver/nvidia/gpus/%s/information", entry->d_name);
    FILE *file = fopen(path, "r");
    if (!file) continue;
    while (fgets(line, sizeof line, file)) {
      if (sscanf(line, "Device Minor: %d", &minor) == 1) break;
    }
    fclose(file);
  }
  closedir(dir);
  return minor;
}

static void keep_container_gpus(uint32_t *ids) {
  uint32_t kept[MAX_GPUS];
  int total = 0, count = 0;
  while (total < MAX_GPUS && ids[total] != INVALID_ID) total++;
  if (total < 2) return;
  for (int i = 0; i < total; i++) {
    int minor = minor_of_bus((ids[i] >> 8) & 0xFF);
    char node[32];
    snprintf(node, sizeof node, "/dev/nvidia%d", minor);
    if (minor >= 0 && access(node, F_OK) == 0) kept[count++] = ids[i];
  }
  fprintf(stderr, "nvenc_one_gpu: host has %d GPUs, kept %d\n", total, count);
  if (!count) return;
  for (int i = 0; i < MAX_GPUS; i++) ids[i] = i < count ? kept[i] : INVALID_ID;
}

int ioctl(int fd, unsigned long request, ...) {
  static int (*real)(int, unsigned long, ...);
  if (!real) real = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");
  va_list args;
  va_start(args, request);
  void *arg = va_arg(args, void *);
  va_end(args);
  int result = real(fd, request, arg);
  if (result == 0 && _IOC_TYPE(request) == 'F' && _IOC_NR(request) == RM_CONTROL
      && _IOC_SIZE(request) == sizeof(struct rm_control)) {
    struct rm_control *control = arg;
    if (control->cmd == GET_ATTACHED_IDS && control->status == 0 && control->params) keep_container_gpus(control->params);
  }
  return result;
}
