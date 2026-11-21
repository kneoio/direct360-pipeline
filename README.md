# direct360-pipeline

The Direct360 job pipeline: GoPro `.360` stitch, preview proxy (360° or flat), telemetry and orientation, and the
preview and final renders of an edit list. One copy, run in three places:

- the Direct360 server, which imports its modules as the `direct360-pipeline` npm dependency;
- the RunPod Serverless worker (`worker/Dockerfile`, `worker/handler.py`);
- the [Direct360 Helper Agent](https://github.com/kneoio/direct360-agent), whose release packages bundle
  `worker/render.js`, what it imports, `lib/` and `worker/gpmf` from this repo.

## Layout

| Path | What |
|---|---|
| `worker/render.js` | A job: reads its JSON input on stdin, prints one JSON result on stdout, progress as `PROGRESS <json>` on stderr. Tasks `render`, `stitch`, `proxy`, `stitch_proxy`, `telemetry`. |
| `worker/upload.js`, `worker/volumeCache.js` | Multipart uploads of results; the source cache (RunPod network volume, or the agent's cache folder). |
| `worker/gpmf/` | `gpmf2json`, GoPro telemetry reader built from GoPro's gpmf-parser (v2.2.1, MIT or Apache-2.0). |
| `worker/handler.py`, `worker/Dockerfile` | The RunPod Serverless worker: the Python handler runs `render.js` for each job. |
| `gpu-stitch/` | The NVIDIA `.360` stitch (NVDEC, CUDA, NVENC), used when a worker has `D360_STITCH_ENGINE=gpu`. |
| `src/` | The modules: edit list planning and rendering (`edl.js`), camera layouts and proxies (`matrix.js`), formats, flat cameras, stabilization, telemetry, overlays, ffmpeg helpers, versions. |
| `lib/` | Fonts for the info overlay and the watermark. |
| `build/GPL-3.0.txt` | Licence text shipped beside a bundled GPL ffmpeg when its build has none. |

## Tests

```sh
npm test
```

Node 20 or newer, on Linux, with `ffmpeg`, `ffprobe` and `python3` on `PATH` (several tests render real video).
`aria2c` and `gpmf2json` (set `GPMF2JSON`) are used where installed.

## RunPod worker

```sh
docker build -f worker/Dockerfile --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
```

RunPod → Serverless → New Endpoint → Deploy from a GitHub repository: this repo, Dockerfile path `worker/Dockerfile`,
build context the repo root.

## Using it from another project

Pin a commit's tarball, so installs need no git:

```json
"direct360-pipeline": "https://codeload.github.com/kneoio/direct360-pipeline/tar.gz/<commit>"
```

and import modules by path, e.g. `import { renderFromEdl } from 'direct360-pipeline/src/edl.js'`.

## Licence

MIT (`LICENSE`). `worker/gpmf/third_party/gpmf-parser` is GoPro's, MIT or Apache-2.0; `lib/fonts/DejaVuSansMono.ttf`
is under its own licence (`lib/fonts/DejaVuSansMono-LICENSE.txt`).
