import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

function checkSelection(directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('./fixtures/stryker-vitest-selection.mjs', import.meta.url)),
      directory,
    ], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-65_536); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      // Stop the runner and its Vitest workers before cleaning their directory.
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore', windowsHide: true,
        });
        killer.once('error', () => child.kill('SIGKILL'));
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, 20_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(`Stryker selection check ${timedOut ? 'timed out' : `exited ${code}`}:\n${output}`));
    });
  });
}

it('keeps per-test mutation selection for nested, padded and anonymous Vitest names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'motion-stryker-selection-'));
  try {
    await checkSelection(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
