import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const BUFFER_BYTES = 256 * 1024;

function descriptorDigest(fd) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(BUFFER_BYTES);
  let position = 0, count;
  while ((count = readSync(fd, buffer, 0, buffer.length, position)) > 0) {
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  return hash.digest('hex');
}

export function fileDigest(file) {
  const fd = openSync(file, 'r');
  try { return descriptorDigest(fd); }
  finally { closeSync(fd); }
}

function executableIdentity(fd) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Qualified executable is not a regular non-empty file');
  if ((stat.mode & 0o222) !== 0) throw new Error('Qualified executable must be read-only');
  return { dev: stat.dev, ino: stat.ino, size: stat.size, nlink: stat.nlink };
}

export function prepareQualifiedExecutable(file, expectedDigest, parent, name) {
  if (process.platform !== 'linux') throw new Error('Qualified descriptor execution requires Linux');
  if (!SHA256.test(expectedDigest ?? '')) throw new TypeError('A qualified ' + name + ' digest is required');
  const source = resolve(file), sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(name + ' source must be a regular file');

  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'qualified-exec-'));
  const staged = join(directory, 'tool');
  let fd = null, closed = false;
  try {
    copyFileSync(source, staged, constants.COPYFILE_EXCL);
    chmodSync(staged, 0o500);
    fd = openSync(staged, constants.O_RDONLY);
    const before = executableIdentity(fd);
    if (descriptorDigest(fd) !== expectedDigest) throw new Error(name + ' does not match its qualified digest');
    unlinkSync(staged);
    const sealed = executableIdentity(fd);
    if (sealed.nlink !== 0 || sealed.dev !== before.dev || sealed.ino !== before.ino)
      throw new Error(name + ' anonymous execution identity is invalid');

    const verify = () => {
      if (closed) throw new Error(name + ' execution identity is closed');
      const current = executableIdentity(fd);
      if (current.dev !== sealed.dev || current.ino !== sealed.ino || current.size !== sealed.size || current.nlink !== 0)
        throw new Error(name + ' execution identity changed');
      if (descriptorDigest(fd) !== expectedDigest) throw new Error(name + ' anonymous bytes changed');
    };
    const run = (args, options = {}) => {
      verify();
      const stdio = options.stdio ?? ['ignore', 'pipe', 'pipe'];
      if (!Array.isArray(stdio) || stdio.length !== 3) throw new TypeError(name + ' requires exactly three stdio channels');
      const result = spawnSync('/proc/self/fd/3', args, { ...options, stdio: [...stdio, fd] });
      verify();
      return result;
    };
    return {
      digest: expectedDigest,
      run,
      verify,
      close() {
        if (closed) return;
        closed = true;
        closeSync(fd);
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch {}
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
