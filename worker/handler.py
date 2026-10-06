# Runpod's serverless SDK is Python; all the actual work is in render.js.
# render.js prints one JSON result on stdout. Progress is `PROGRESS ` + JSON on
# stderr, forwarded with progress_update so it shows up on GET /status while
# the job is IN_PROGRESS. Other stderr lines are the worker logs.
#
# node runs in its own process group. Cancel, timeout (SIGTERM), and the
# handler's finally kill that group so a warm worker does not keep ffmpeg.
import json
import os
import signal
import subprocess
import sys
import threading

import runpod

_proc = None
_proc_lock = threading.Lock()


def _kill_group(proc):
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def _on_signal(signum, _frame):
    with _proc_lock:
        proc = _proc
    _kill_group(proc)
    raise SystemExit(128 + signum)


def _job_cancelled(job):
    for owner in (runpod.serverless, runpod):
        fn = getattr(owner, "is_job_cancelled", None)
        if callable(fn):
            try:
                return bool(fn(job))
            except TypeError:
                try:
                    return bool(fn())
                except Exception:
                    return False
            except Exception:
                return False
    return False


def handler(job):
    global _proc
    proc = subprocess.Popen(
        ["node", "/app/worker/render.js"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    with _proc_lock:
        _proc = proc
    stop = threading.Event()
    try:
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

        def watch_cancel():
            while not stop.wait(2):
                if proc.poll() is not None:
                    return
                if _job_cancelled(job):
                    _kill_group(proc)
                    return

        logs = threading.Thread(target=read_stderr, daemon=True)
        logs.start()
        watchdog = threading.Thread(target=watch_cancel, daemon=True)
        watchdog.start()
        stdout = proc.stdout.read()
        code = proc.wait()
        stop.set()
        logs.join(timeout=5)
        watchdog.join(timeout=1)

        lines = stdout.strip().splitlines()
        if not lines:
            return {"error": f"render.js exited {code} with no output"}
        return json.loads(lines[-1])
    finally:
        stop.set()
        _kill_group(proc)
        with _proc_lock:
            if _proc is proc:
                _proc = None


signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)

runpod.serverless.start({"handler": handler})
