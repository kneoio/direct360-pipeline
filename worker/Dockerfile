# RunPod Serverless worker for the full-quality render. Build from the repo
# root: docker build -f worker/Dockerfile .
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages runpod \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY lib ./lib
COPY worker ./worker
CMD ["python3", "-u", "/app/worker/handler.py"]
