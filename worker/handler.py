# Runpod's serverless SDK is Python; all the actual work is in render.js.
# render.js prints one JSON result on stdout. Progress is `PROGRESS ` + JSON on
# stderr, forwarded with progress_update so it shows up on GET /status while
# the job is IN_PROGRESS. Other stderr lines are the worker logs.
import json
import subprocess
import sys
import threading

import runpod


def handler(job):
    proc = subprocess.Popen(
        ["node", "/app/worker/render.js"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    proc.stdin.write(json.dumps(job["input"]))
    proc.stdin.close()

    def read_stderr():
        for line in proc.stderr:
            text = line.rstrip("\n")
            if text.startswith("PROGRESS "):
                try:
                    runpod.serverless.progress_update(job, json.loads(text[len("PROGRESS "):]))
                except Exception as e:
                    print(f"progress_update failed: {e}", file=sys.stderr, flush=True)
            elif text:
                print(text, file=sys.stderr, flush=True)

    logs = threading.Thread(target=read_stderr)
    logs.start()
    stdout = proc.stdout.read()
    code = proc.wait()
    logs.join()

    lines = stdout.strip().splitlines()
    if not lines:
        return {"error": f"render.js exited {code} with no output"}
    return json.loads(lines[-1])


runpod.serverless.start({"handler": handler})
