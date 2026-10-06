# Runpod's serverless SDK is Python; all the actual work is in render.js.
# render.js prints one JSON result on stdout. Progress is `PROGRESS ` + JSON on
# stderr, forwarded with progress_update so it shows up on GET /status while
# the job is IN_PROGRESS. Other stderr lines are the worker logs.
#
# node runs in its own process group. Cancel, timeout, and the handler's
# finally kill that group (SIGTERM, then SIGKILL after 3s) so a warm worker
# does not keep ffmpeg.
import asyncio
import json
import os
import signal
import sys
import threading
import time

_proc = None


def _kill_group_sync(proc):
    if proc is None or proc.returncode is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return


def _sigkill_later(pid):
    time.sleep(3)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def kill_group(proc):
    """SIGTERM the process group, then SIGKILL if it is still alive after 3s."""
    if proc is None or proc.returncode is not None:
        return
    pid = proc.pid
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    threading.Thread(target=_sigkill_later, args=(pid,), daemon=True).start()
    try:
        await asyncio.wait_for(asyncio.shield(proc.wait()), 3)
    except asyncio.TimeoutError:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    except asyncio.CancelledError:
        raise


def _on_signal(signum, _frame):
    _kill_group_sync(_proc)
    raise SystemExit(128 + signum)


def _job_cancelled(job):
    import runpod
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


async def run_grouped(argv, stdin_text, on_stderr_line):
    """Run argv in a new session. Cancel and finally kill the whole group."""
    global _proc
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    _proc = proc
    try:
        if stdin_text:
            proc.stdin.write(stdin_text.encode())
        proc.stdin.close()

        async def pump():
            while True:
                line = await proc.stderr.readline()
                if not line:
                    return
                on_stderr_line(line.decode(errors="replace"))

        stderr_task = asyncio.create_task(pump())
        try:
            stdout = await proc.stdout.read()
            code = await proc.wait()
        finally:
            stderr_task.cancel()
            try:
                await stderr_task
            except asyncio.CancelledError:
                pass
        return code, stdout
    finally:
        await kill_group(proc)
        if _proc is proc:
            _proc = None


async def handler(job):
    def on_line(text):
        line = text.rstrip("\n")
        if line.startswith("PROGRESS "):
            try:
                import runpod
                runpod.serverless.progress_update(job, json.loads(line[len("PROGRESS "):]))
            except Exception as e:
                print(f"progress_update failed: {e}", file=sys.stderr, flush=True)
        elif line:
            print(line, file=sys.stderr, flush=True)

    async def watch_cancel():
        while True:
            await asyncio.sleep(2)
            if _job_cancelled(job):
                raise asyncio.CancelledError()

    run_task = asyncio.create_task(run_grouped(
        ["node", "/app/worker/render.js"],
        json.dumps(job["input"]),
        on_line,
    ))
    watch_task = asyncio.create_task(watch_cancel())
    try:
        done, _pending = await asyncio.wait(
            {run_task, watch_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if watch_task in done and not run_task.done():
            run_task.cancel()
        code, stdout = await run_task
        lines = stdout.decode(errors="replace").strip().splitlines()
        if not lines:
            return {"error": f"render.js exited {code} with no output"}
        return json.loads(lines[-1])
    finally:
        watch_task.cancel()
        if not run_task.done():
            run_task.cancel()
        await asyncio.gather(run_task, watch_task, return_exceptions=True)


def main():
    import runpod
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
