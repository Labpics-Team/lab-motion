/** Частный CPU clock владельца server-profile; пакет библиотеки его не включает. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import { sha256File } from '../compare/provenance.mjs';
import { SERVER_PROFILE, serverProfileDigest } from './server-profile-registration.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLOCK = 'CLOCK_THREAD_CPUTIME_ID';
const SOURCE_FILES = [
  'bench/profile/server-thread-cpu-clock.c',
  'bench/profile/native-clock/include/js_native_api.h',
  'bench/profile/native-clock/include/js_native_api_types.h',
  'bench/profile/native-clock/include/node_api.h',
  'bench/profile/native-clock/include/node_api_types.h',
];
const FLAGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-shared', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8'];
let prepared;

function refuse(message, raw) {
  return Object.assign(new Error(`server CPU clock: ${message}`), { raw });
}

function sourceHashes() {
  return Object.fromEntries(SOURCE_FILES.map((name) => [name, sha256File(path.join(ROOT, name))]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function compilerPath() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const file = path.join(directory, 'cc');
    try { accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* Следующий конкретный PATH entry. */ }
  }
  throw refuse('нет C compiler для частного getter', { path: process.env.PATH });
}

function libcPath() {
  const lines = readFileSync('/proc/self/maps', 'utf8').split('\n');
  const names = new Set(lines.flatMap((line) => {
    const match = /\s(\/[^\n]*\/libc\.so\.6)$/.exec(line);
    return match ? [realpathSync(match[1])] : [];
  }));
  if (names.size !== 1) throw refuse('не удалось связать одну фактическую libc', { libraries: [...names] });
  return [...names][0];
}

/** Подготавливает бинарный getter до регистрации и любых SUT samples. */
export function prepareServerThreadCpuClock({ directory }) {
  if (prepared) throw refuse('getter уже подготовлен; повторная registration в том же процессе запрещена');
  if (process.platform !== 'linux' || process.arch !== 'x64' || !isMainThread || process.version !== SERVER_PROFILE.clockError.nodeVersion) {
    throw refuse('нужны зарегистрированные Linux x64/main-thread/Node', { platform: process.platform, arch: process.arch, isMainThread, node: process.version });
  }
  const nativeSources = sourceHashes();
  if (!isDeepStrictEqual(nativeSources, SERVER_PROFILE.clockError.nativeSourceFiles)) {
    throw refuse('native source/header bytes не совпадают с clock model', { observed: nativeSources, registered: SERVER_PROFILE.clockError.nativeSourceFiles });
  }
  const nativeDirectory = path.join(directory, 'native-clock');
  mkdirSync(nativeDirectory, { recursive: true });
  const binary = path.join(nativeDirectory, 'thread-cpu-clock.node');
  if (existsSync(binary)) throw refuse('native binary уже существует; stale/replay запрещён', { binary });
  const compiler = compilerPath();
  const compilerVersion = execFileSync(compiler, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const binarySha256 = sha256File(compiler);
  const flags = [...FLAGS, '-I', path.join(ROOT, 'bench/profile/native-clock/include'), '-o', binary, path.join(ROOT, SOURCE_FILES[0])];
  try { execFileSync(compiler, flags, { encoding: 'utf8', timeout: 30_000 }); } catch (error) {
    throw refuse('сборка native getter отказала', { compiler, flags, status: error.status, signal: error.signal,
      stdout: error.stdout?.toString(), stderr: error.stderr?.toString() });
  }
  const native = createRequire(import.meta.url)(binary);
  if (typeof native.read !== 'function' || typeof native.info !== 'function') throw refuse('native getter не содержит зарегистрированный ABI');
  const info = native.info();
  if (!Number.isSafeInteger(info.pid) || info.pid !== process.pid || info.tid !== info.pid || !/^[1-9]\d*$/.test(info.nominalResolutionNs)) {
    throw refuse('native getter не связан с текущим main thread', info);
  }
  const libc = libcPath();
  const metadata = { schema: 1, clock: CLOCK, pid: info.pid, tid: info.tid, napiVersion: 8,
    node: { version: process.version, executableSha256: sha256File(process.execPath) },
    nativeBinary: { path: binary, bytes: readFileSync(binary).length, sha256: sha256File(binary) },
    nativeSources, nativeSourceDigest: serverProfileDigest(nativeSources),
    compiler: { path: compiler, version: compilerVersion, binarySha256, flags },
    libc: { path: libc, sha256: sha256File(libc) }, nominalResolutionNs: info.nominalResolutionNs,
    nominalResolutionIsNotErrorCertificate: true };
  const binaryRead = native.read;
  let previous;
  const read = () => {
    const acquired = binaryRead();
    const raw = { clock: CLOCK, pid: acquired.pid, tid: acquired.tid, seconds: acquired.seconds,
      nanoseconds: acquired.nanoseconds, valueNs: null };
    if (!isMainThread || raw.pid !== process.pid || raw.pid !== metadata.pid || raw.tid !== metadata.tid ||
        typeof raw.seconds !== 'string' || !/^(0|[1-9]\d*)$/.test(raw.seconds) ||
        !Number.isSafeInteger(raw.nanoseconds) || raw.nanoseconds < 0 || raw.nanoseconds >= 1_000_000_000) {
      throw refuse('недопустимый actual native endpoint/worker/fork', raw);
    }
    const value = BigInt(raw.seconds) * 1_000_000_000n + BigInt(raw.nanoseconds);
    raw.valueNs = String(value);
    if (previous !== undefined && value < previous) throw refuse('native CPU counter пошёл назад', { acquired: raw, previous: String(previous) });
    previous = value;
    return raw;
  };
  const assertUnchanged = () => {
    const currentSources = sourceHashes();
    if (!isMainThread || process.pid !== metadata.pid ||
        serverProfileDigest(currentSources) !== metadata.nativeSourceDigest ||
        sha256File(binary) !== metadata.nativeBinary.sha256 || sha256File(compiler) !== metadata.compiler.binarySha256 ||
        sha256File(libc) !== metadata.libc.sha256 || sha256File(process.execPath) !== metadata.node.executableSha256) {
      throw refuse('native getter/source/compiler/libc/runtime identity изменились', { metadata });
    }
  };
  prepared = { metadata, read, assertUnchanged };
  return { metadata, assertUnchanged };
}

/** Pure import не требует compiler/native binary; actual read без подготовки запрещён. */
export function readServerThreadCpuEndpoint() {
  if (!prepared) throw refuse('actual getter не подготовлен до регистрации');
  return prepared.read();
}
