# RunPod Serverless worker for the full-quality render. Build from the repo
# root: docker build -f worker/Dockerfile .
#
# gpmf2json is GoPro's gpmf-parser (tag v2.2.1, MIT or Apache-2.0). The
# licenses are copied into the runtime image; sources live under worker/gpmf.
FROM debian:bookworm-slim AS gpmf
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev make \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY worker/gpmf /src
RUN make

FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates aria2 \
 && pip3 install --no-cache-dir --break-system-packages runpod \
 && rm -rf /var/lib/apt/lists/*
COPY --from=gpmf /src/gpmf2json /usr/local/bin/gpmf2json
COPY --from=gpmf /src/third_party/gpmf-parser/LICENSE-MIT /usr/local/share/gpmf-parser/LICENSE-MIT
COPY --from=gpmf /src/third_party/gpmf-parser/LICENSE-APACHE /usr/local/share/gpmf-parser/LICENSE-APACHE
COPY --from=gpmf /src/third_party/gpmf-parser/LICENSE.txt /usr/local/share/gpmf-parser/LICENSE.txt
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY lib ./lib
COPY worker ./worker
CMD ["python3", "-u", "/app/worker/handler.py"]
