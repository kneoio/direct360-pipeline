# RunPod Serverless worker for the full-quality render. Build from the repo
# root: docker build -f worker/Dockerfile .
#
# The job pipeline (render.js and the modules it imports) is the public direct360-helper package
# (github.com/kneoio/direct360-helper), installed by npm ci from package.json.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# gpmf2json is GoPro's gpmf-parser (tag v2.2.1, MIT or Apache-2.0). The
# licenses are copied into the runtime image; sources live in direct360-helper's worker/gpmf.
FROM debian:bookworm-slim AS gpmf
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev make \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY --from=deps /app/node_modules/direct360-helper/worker/gpmf /src
RUN make

# The GPU stitch, used when the endpoint sets D360_STITCH_ENGINE=gpu. PTX only, so
# the driver compiles the kernels for whatever card the worker has.
FROM debian:bookworm-slim AS gpustitch
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends nvidia-cuda-toolkit nvidia-cuda-dev g++ libavcodec-dev libavformat-dev libavutil-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY gpu-stitch /src
RUN nvcc -O3 --std=c++17 --cudart static -arch=compute_75 -code=compute_75 -x cu main.cu -o gpu-stitch -lavformat -lavcodec -lavutil
RUN gcc -shared -fPIC -O2 -o libnvenc_one_gpu.so nvenc_one_gpu.c -ldl

FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates aria2 tini \
 && pip3 install --no-cache-dir --break-system-packages 'runpod==1.12.0' \
 && rm -rf /var/lib/apt/lists/*
# The info overlay needs ffmpeg's `ass` filter (libass). Debian's ffmpeg has it; fail the
# build if a different package ever drops it. The font it draws with is direct360-helper's lib/fonts/DejaVuSansMono.ttf.
RUN ffmpeg -hide_banner -filters 2>/dev/null | grep -Eq '^ *[A-Z.]+ +ass +V->V'
COPY --from=gpmf /src/gpmf2json /usr/local/bin/gpmf2json
ENV GPMF2JSON=/usr/local/bin/gpmf2json
COPY --from=gpmf /src/third_party/gpmf-parser/LICENSE-MIT /usr/local/share/gpmf-parser/LICENSE-MIT
COPY --from=gpmf /src/third_party/gpmf-parser/LICENSE-APACHE /usr/local/share/gpmf-parser/LICENSE-APACHE
COPY --from=gpmf /src/third_party/gpmf-parser/LICENSE.txt /usr/local/share/gpmf-parser/LICENSE.txt
COPY --from=gpustitch /src/gpu-stitch /usr/local/bin/gpu-stitch
COPY --from=gpustitch /src/libnvenc_one_gpu.so /usr/local/lib/libnvenc_one_gpu.so
# Asks the NVIDIA runtime for the video decode and encode libraries too.
ENV NVIDIA_DRIVER_CAPABILITIES=all
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY lib ./lib
RUN test -s /app/node_modules/direct360-helper/lib/fonts/DejaVuSansMono.ttf
RUN test -s "/app/node_modules/direct360-helper/lib/fonts/Digital Play Italic St.ttf"
RUN test -d /app/lib/emoji
COPY worker ./worker
# Shown as the worker's commit in logs and stats; the version itself is a hash of the files.
ARG GIT_SHA=
ENV D360_WORKER_VERSION=$GIT_SHA
# tini reaps grandchildren ffmpeg leaves behind when the job is killed.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "-u", "/app/worker/handler.py"]
