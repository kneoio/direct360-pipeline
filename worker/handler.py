# Runpod's serverless SDK is Python; all the actual work is in render.js.
# render.js prints one JSON result on stdout. Progress is `PROGRESS ` + JSON on
# stderr, forwarded with progress_update so it shows up on GET /status while
# the job is IN_PROGRESS. Other stderr lines are the worker logs.
#
# node runs in its own process group. The handler's finally signals that
# group even after node has exited (SIGTERM, then SIGKILL if the group is
# still there after 3s) so a warm worker does not keep ffmpeg.
# runpod 1.12 installs its own signal handlers and has no is_job_cancelled,
# so this process does not watch for cancel itself.
import asyncio
import json
import os
import signal
import sys

_proc = None
# ffmpeg progress and aria2 lines can exceed the 64 KiB readline default.
_STDERR_LIMIT = 1024 * 1024


def _group_alive(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


async def _wait_group_gone(proc):
    """Reap the leader, then wait until killpg sees nobody left."""
    if proc.returncode is None:
        try:
            await proc.wait()
        except (ProcessLookupError, ChildProcessError):
            pass
    while _group_alive(proc.pid):
        await asyncio.sleep(0.05)


async def kill_group(proc):
    """SIGTERM the process group, then SIGKILL if anyone is left after 3s.

    The leader may already have exited. Grandchildren stay in the group, so
    the signal is sent anyway.
    """
    if proc is None:
        return
    pid = proc.pid
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(_wait_group_gone(proc), 3)
    except asyncio.TimeoutError:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(_wait_group_gone(proc), 1)
        except asyncio.TimeoutError:
            pass
    except asyncio.CancelledError:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        raise


async def run_grouped(argv, stdin_text, on_stderr_line):
    """Run argv in a new session. Cancel and finally kill the whole group."""
    global _proc
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
        limit=_STDERR_LIMIT,
    )
    _proc = proc
    stdout = b''
    stderr_task = None
    try:
        if stdin_text:
            proc.stdin.write(stdin_text.encode())
        proc.stdin.close()

        async def pump():
            while True:
                try:
                    line = await proc.stderr.readline()
                except asyncio.LimitOverrunError as overrun:
                    # The separator was not in the buffer. Drain it and keep going.
                    chunk = await proc.stderr.read(max(1, overrun.consumed))
                    if not chunk:
                        return
                    on_stderr_line(chunk.decode(errors="replace"))
                    continue
                if not line:
                    return
                on_stderr_line(line.decode(errors="replace"))

        stderr_task = asyncio.create_task(pump())
        stdout = await proc.stdout.read()
    finally:
        if stderr_task is not None:
            stderr_task.cancel()
            try:
                await stderr_task
            except asyncio.CancelledError:
                pass
        # Signal before the leader is reaped so the group id is still ours.
        await kill_group(proc)
        if _proc is proc:
            _proc = None
    return proc.returncode, stdout


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

    code, stdout = await run_grouped(
        ["node", "/app/worker/render.js"],
        json.dumps(job["input"]),
        on_line,
    )
    lines = stdout.decode(errors="replace").strip().splitlines()
    if not lines:
        return {"error": f"render.js exited {code} with no output"}
    return json.loads(lines[-1])


def main():
    import runpod
    runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
