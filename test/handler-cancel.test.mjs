import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = path.dirname(fileURLToPath(new URL('../worker/handler.py', import.meta.url)));

test('a cancelled job leaves no child from the process group', async () => {
  const pidfile = path.join(os.tmpdir(), `d360-handler-${process.pid}.pid`);
  fs.rmSync(pidfile, { force: true });
  const script = `
import asyncio, os, sys
sys.path.insert(0, ${JSON.stringify(worker)})
import handler

pidfile = sys.argv[1]
child = (
    "import os, sys, time, subprocess, pathlib\\n"
    "p = subprocess.Popen(['sleep', '120'])\\n"
    "pathlib.Path(sys.argv[1]).write_text(str(p.pid))\\n"
    "time.sleep(120)\\n"
)

async def main():
    task = asyncio.create_task(handler.run_grouped(
        [sys.executable, "-c", child, pidfile],
        "",
        lambda line: None,
    ))
    for _ in range(100):
        if os.path.exists(pidfile) and os.path.getsize(pidfile) > 0:
            break
        await asyncio.sleep(0.05)
    else:
        task.cancel()
        print("missing")
        return
    pid = int(open(pidfile).read().strip())
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    await asyncio.sleep(0.3)
    print("dead" if not os.path.exists(f"/proc/{pid}") else "alive")

asyncio.run(main())
`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script, pidfile], { encoding: 'utf8' });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
  try {
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /dead/);
    if (fs.existsSync(pidfile)) {
      const pid = Number(fs.readFileSync(pidfile, 'utf8'));
      assert.equal(fs.existsSync(`/proc/${pid}`), false);
    }
  } finally {
    fs.rmSync(pidfile, { force: true });
  }
});
