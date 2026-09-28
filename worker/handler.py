# RunPod's serverless SDK is Python; all the actual work is in render.js.
import json
import subprocess

import runpod


def handler(job):
    proc = subprocess.run(
        ["node", "/app/worker/render.js"],
        input=json.dumps(job["input"]),
        stdout=subprocess.PIPE,
        text=True,
    )
    lines = proc.stdout.strip().splitlines()
    if not lines:
        return {"error": f"render.js exited {proc.returncode} with no output"}
    return json.loads(lines[-1])


runpod.serverless.start({"handler": handler})
