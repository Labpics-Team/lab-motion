// Обязательная Linux/Node24.19 проверка private getter; не performance sample.
import assert from 'node:assert/strict';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = fileURLToPath(new URL('../..', import.meta.url));
const self = fileURLToPath(import.meta.url);
const owner = new URL('../../bench/profile/server-thread-cpu-clock.mjs', import.meta.url);
const source = path.join(root, 'bench/profile/server-thread-cpu-clock.c');
const host = path.join(root, 'test/fixtures/server-thread-cpu-clock-host.c');
const include = path.join(root, 'bench/profile/native-clock/include');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-shared', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8'];
const codes = [['read-errno', 'read', 'CLOCK_READ'], ['negative-seconds', 'read', 'CLOCK_VALUE'],
  ['negative-nanoseconds', 'read', 'CLOCK_VALUE'], ['overflow-nanoseconds', 'read', 'CLOCK_VALUE'],
  ['negative-pid', 'read', 'CLOCK_IDENTITY'], ['negative-tid', 'read', 'CLOCK_IDENTITY'],
  ['resolution-errno', 'info', 'CLOCK_RESOLUTION'], ['zero-resolution', 'info', 'CLOCK_RESOLUTION']];

async function child(mode, directory) {
  if (mode === 'operator-signal') {
    const { parseServerProfileArgs, runServerProfile, withServerProfileSignals } = await import(new URL('../../bench/profile/server-profile-runner.mjs', import.meta.url));
    const before = { interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM') };
    let aborts = 0, received;
    const artifact = await withServerProfileSignals(async (signal) => {
      const stopped = new Promise(resolve => signal.addEventListener('abort', () => { aborts++; resolve(); }, { once: true }));
      process.channel.ref();
      process.send({ ready: true, pid: process.pid });
      await stopped;
      process.channel.unref();
      received = signal.reason.raw.signal;
      return runServerProfile(parseServerProfileArgs(['--baseline', root, '--candidate', directory, '--browser', 'chromium', '--out', path.join(directory, 'out')]), { signal });
    });
    assert.equal(aborts, 1); assert.equal(received, process.argv[5]);
    assert.equal(process.listenerCount('SIGINT'), before.interrupt);
    assert.equal(process.listenerCount('SIGTERM'), before.terminate);
    assert.equal(artifact.verdict, 'UNPROVEN'); assert.equal(artifact.registration, null);
    assert.equal(artifact.failures.length, 1); assert.equal(artifact.failures[0].error.code, 'OPERATOR_INTERRUPTION');
    assert.equal(artifact.failures[0].error.raw.signal, received); assert.deepEqual(artifact.stages, []);
    const raw = readFileSync(path.join(directory, 'out/server-profile.json'));
    assert.deepEqual(JSON.parse(raw), artifact);
    assert.equal(readFileSync(path.join(directory, 'out/server-profile.sha256'), 'utf8').split(' ')[0], hash(raw));
    const journal = readFileSync(path.join(directory, 'out/journal.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(journal.map(row => row.type), ['failure', 'finished']);
    assert.deepEqual(journal.at(-1).value, { verdict: 'UNPROVEN', digest: hash(raw) });
    return { mode, signal: received, aborts, artifact, journal, scope: 'настоящий сигнал Node через общий CLI wrapper и реальный отказ/finally до подготовки; без SUT серии' };
  }
  if (mode === 'native-abi') {
    const native = createRequire(import.meta.url)(directory);
    process.env.MOTION_CLOCK_CHECK_MODE = 'large-exact';
    let acquired, info;
    assert.doesNotThrow(() => { acquired = native.read(); });
    assert.doesNotThrow(() => { info = native.info(); });
    assert.deepEqual(acquired, { seconds: '9007199254740993', nanoseconds: 17, pid: process.pid, tid: process.pid });
    assert.deepEqual(info, { pid: process.pid, tid: process.pid, nominalResolutionNs: '1' });
    for (const [fault, method, code] of codes) {
      process.env.MOTION_CLOCK_CHECK_MODE = fault;
      assert.throws(() => native[method](), error => error.code === code, fault);
    }
    return { mode, controls: codes.length + 2, exactLargeSeconds: true };
  }
  const api = await import(owner);
  assert.throws(() => api.readServerThreadCpuEndpoint(), /не подготовлен/);
  if (mode === 'worker') {
    const worker = new Worker(`(async () => {
      const { parentPort } = require('node:worker_threads');
      const { prepareServerThreadCpuClock } = await import(${JSON.stringify(owner.href)});
      try { prepareServerThreadCpuClock({directory:${JSON.stringify(directory)}}); parentPort.postMessage({accepted:true}); }
      catch(error) { parentPort.postMessage({message:error.message,raw:error.raw}); }
    })();`, { eval: true });
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', code => { if (code) reject(new Error('worker exit ' + code)); });
    });
    await worker.terminate();
    assert.equal(result.raw?.isMainThread, false); assert.match(result.message, /main-thread/);
    return { mode, refusal: result };
  }
  if (mode === 'stale') {
    mkdirSync(path.join(directory, 'native-clock'), { recursive: true });
    const binary = path.join(directory, 'native-clock/thread-cpu-clock.node');
    writeFileSync(binary, 'retained-stale-binary');
    assert.throws(() => api.prepareServerThreadCpuClock({ directory }), /stale\/replay/);
    assert.equal(readFileSync(binary, 'utf8'), 'retained-stale-binary');
    return { mode, retainedOriginal: true };
  }
  if (mode === 'missing-compiler') {
    process.env.PATH = directory;
    assert.throws(() => api.prepareServerThreadCpuClock({ directory }), /нет C compiler/);
    return { mode, refusal: true };
  }
  assert.equal(mode, 'actual-api');
  const prepared = api.prepareServerThreadCpuClock({ directory });
  const { metadata } = prepared;
  assert.equal(metadata.node.version, 'v24.19.0');
  assert.equal(metadata.pid, process.pid); assert.equal(metadata.tid, process.pid);
  assert.equal(metadata.clock, 'CLOCK_THREAD_CPUTIME_ID');
  assert.equal(metadata.nominalResolutionIsNotErrorCertificate, true);
  for (const [file, digest] of Object.entries(metadata.nativeSources)) assert.equal(hash(readFileSync(path.join(root, file))), digest);
  assert.equal(hash(readFileSync(metadata.nativeBinary.path)), metadata.nativeBinary.sha256);
  const first = api.readServerThreadCpuEndpoint();
  let sum = 0; for (let i = 0; i < 8192; i++) sum = (sum + i) | 0;
  assert.equal(sum, 33550336);
  const second = api.readServerThreadCpuEndpoint();
  for (const read of [first, second]) {
    assert.equal(read.pid, process.pid); assert.equal(read.tid, process.pid);
    assert.equal(read.valueNs, String(BigInt(read.seconds) * 1000000000n + BigInt(read.nanoseconds)));
  }
  assert(BigInt(second.valueNs) > BigInt(first.valueNs));
  prepared.assertUnchanged();
  assert.throws(() => api.prepareServerThreadCpuClock({ directory }), /уже подготовлен/);
  appendFileSync(metadata.nativeBinary.path, Buffer.from([0]));
  assert.throws(() => prepared.assertUnchanged(), /identity изменились/);
  return { mode, metadata, acquired: [first, second], scope: 'actual API/ABI, не физическая точность clock model' };
}

function run(mode, directory) {
  return spawnSync(process.execPath, [self, '--case', mode, directory], { encoding: 'utf8', timeout: 30000 });
}

async function runSignal(directory, signal) {
  mkdirSync(directory);
  const child = fork(self, ['--case', 'operator-signal', directory, signal], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '', sent = false;
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`operator-signal ${signal}: timeout`)); }, 30000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.on('message', message => {
      if (message?.ready !== true || sent) return;
      sent = true; assert.equal(message.pid, child.pid);
      assert(child.kill(signal)); assert(child.kill(signal));
    });
    child.once('close', (code, nativeSignal) => {
      clearTimeout(timeout);
      try {
        assert(sent); assert.equal(nativeSignal, null); assert.equal(code, 0, stderr || stdout);
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
  });
}

async function main() {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.version, 'v24.19.0');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'motion-native-clock-check-'));
  const records = [];
  try {
    for (const mode of ['actual-api', 'worker', 'stale', 'missing-compiler']) {
      const result = run(mode, path.join(directory, mode));
      assert.equal(result.status, 0, `${mode}: ${result.stderr || result.stdout}`);
      records.push(JSON.parse(result.stdout));
    }
    const original = readFileSync(source, 'utf8');
    const replacements = [
      ['wrong-clock', 'CLOCK_THREAD_CPUTIME_ID', 'CLOCK_PROCESS_CPUTIME_ID', true],
      ['read-errno', 'if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value) != 0) return fail(env, "CLOCK_READ", strerror(errno));',
        '(void)clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value);'],
      ['invalid-timespec', 'if (value.tv_sec < 0 || value.tv_nsec < 0 || value.tv_nsec >= 1000000000L)', 'if (0)'],
      ['invalid-identity', 'if (pid <= 0 || tid <= 0)', 'if (0)'],
      ['seconds-number-loss', '!string_field(env, result, "seconds", seconds)', '!integer_field(env, result, "seconds", (int64_t)value.tv_sec)'],
      ['resolution-errno', 'if (clock_getres(CLOCK_THREAD_CPUTIME_ID, &resolution) != 0) return fail(env, "CLOCK_RESOLUTION", strerror(errno));',
        '(void)clock_getres(CLOCK_THREAD_CPUTIME_ID, &resolution);'],
    ];
    for (const [name, before, after, all] of [['healthy-native', '', '', false], ...replacements]) {
      if (before) assert(original.includes(before), name);
      const body = before ? all ? original.replaceAll(before, after) : original.replace(before, after) : original;
      const file = path.join(directory, name + '.c'), binary = path.join(directory, name + '.node');
      writeFileSync(file, body);
      const argv = [...flags, '-I', include, '-o', binary, file, host,
        '-Wl,--wrap=clock_gettime', '-Wl,--wrap=clock_getres', '-Wl,--wrap=getpid', '-Wl,--wrap=syscall'];
      execFileSync('cc', argv, { encoding: 'utf8', timeout: 30000 });
      const result = run('native-abi', binary);
      if (before) {
        assert.equal(result.status, 1, `${name}: mutant must reach the independent ABI oracle`);
        assert.match(result.stderr, /AssertionError/);
      } else assert.equal(result.status, 0, result.stderr);
      records.push({ name, sourceSha256: hash(Buffer.from(body)), binarySha256: hash(readFileSync(binary)),
        argv, exitCode: result.status, killed: Boolean(before), stdout: result.stdout, stderr: result.stderr });
    }
    for (const signal of ['SIGINT', 'SIGTERM']) records.push(await runSignal(path.join(directory, signal), signal));
    process.stdout.write(JSON.stringify({ node: process.version, kernel: os.release(), sourceSha256: hash(readFileSync(source)),
      hostSha256: hash(readFileSync(host)), records, registeredTimingSamples: 0 }) + '\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[2] === '--case') {
  try { process.stdout.write(JSON.stringify(await child(process.argv[3], process.argv[4])) + '\n'); }
  catch (error) { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; }
} else await main();
