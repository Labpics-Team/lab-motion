// Размер существующего синтетического max-N формата; не измерение пакета или SUT.
import { readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { SERVER_PROFILE, serverProfileDigest } from '/workspace/lab-motion/bench/profile/server-profile-registration.mjs';
import { compactServerCpuEvidence, expandServerCpuEvidence } from '/workspace/lab-motion/bench/profile/server-profile-contract.mjs';

const root = '/workspace/lab-motion';
const output = '/tmp/motion-native-rle-max-carrier-bound-20261002';
const original = '/tmp/motion-server-stock-c-profile-20261001T1610Z';
const frozen = '/tmp/motion-server-method-stock-c-final-20261001T172036Z/source';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const source = readFileSync(`${original}/max-format-fixtures.mjs`, 'utf8');
const oldReceipt = JSON.parse(readFileSync(`${original}/maxN1024-consumer-receipt.json`, 'utf8'));
if (process.version !== SERVER_PROFILE.clockError.nodeVersion) throw new Error('неверная версия Node для metadata control');
const oldPins = {
  fixture: '70c5a15e822e779983c9bd05bdd1de4ae733382de9c7bc8aca57dc952d3873ef',
  receipt: '66e93dc4257595c2b0cb73ca21734d8d8822df0c6b25b30e5e9f6d1c64c58404',
};
if (sha(source) !== oldPins.fixture || sha(readFileSync(`${original}/maxN1024-consumer-receipt.json`)) !== oldPins.receipt) throw new Error('старый первичный шаблон изменился');
if (SERVER_PROFILE.maxRuns !== 1024 || SERVER_PROFILE.repetitions !== 8 || SERVER_PROFILE.warmupRuns !== 4 || SERVER_PROFILE.pilotRuns !== 8 || SERVER_PROFILE.engineScenes.length !== 3 || SERVER_PROFILE.browserScenes.length !== 2) throw new Error('форма max-N изменилась');

// Берём только две функции старого исходного шаблона, без импорта его стенда.
function oldFunction(name) {
  const begin = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}\n', begin) + 2;
  if (begin < 0 || end < begin) throw new Error(`нет ${name}`);
  return Function('createHash', 'SERVER_PROFILE', `return (${source.slice(begin, end)});`)(createHash, SERVER_PROFILE);
}
const oldEngine = oldFunction('engineRaw'), oldStock = oldFunction('stockRaw');
const identity = { clock: SERVER_PROFILE.clockError.engineClock, pid: Number.MAX_SAFE_INTEGER, tid: Number.MAX_SAFE_INTEGER };
const maxSeconds = 9_223_372_036_854_775_807n;
const firstNs = (maxSeconds - 20_000_000n) * 1_000_000_000n + 980_000_000n;
const sampleIdentityMember = Buffer.byteLength(`,"cpuClock":${JSON.stringify(identity)}`);
function endpoint(valueNs, sequence) {
  return { sequence, ...identity, seconds: String(valueNs / 1_000_000_000n), nanoseconds: Number(valueNs % 1_000_000_000n), valueNs: String(valueNs) };
}

const vectors = [];
let ordinal = 0;
function replacement(scene, multiplier) {
  const stock = scene.workload === 'stock-c';
  const previous = (stock ? oldStock(scene, multiplier) : oldEngine(scene)).raw;
  const base = BigInt(previous.clockReads[0].valueNs);
  const next = previous.clockReads.map((read) => ({ ...read, valueNs: String(firstNs + BigInt(ordinal) * 8_000_000_000n + BigInt(read.valueNs) - base) }));
  ordinal++;
  const dense = next.map((read) => endpoint(BigInt(read.valueNs), read.sequence));
  if (!dense.every((read, index) => read.seconds.length === 19 && String(read.nanoseconds).length === 9 && read.valueNs.length === 28 && read.pid === read.tid && read.valueNs === next[index].valueNs)) throw new Error('не достигнута коррелированная максимальная ширина');
  const encoded = compactServerCpuEvidence(dense);
  if (encoded.runs.length !== 1 || !isDeepStrictEqual(expandServerCpuEvidence(encoded, next.length), dense)) throw new Error('RLE потерял приобретённые поля');
  const record = { scene: scene.id, multiplier, endpointCount: next.length,
    oldCpuArrayBytes: bytes(previous.cpuReads), widestCpuRleBytes: bytes(encoded),
    oldClockReadsBytes: bytes(previous.clockReads), widestClockReadsBytes: bytes(next),
    replacementDeltaBytes: bytes(encoded) - bytes(previous.cpuReads) + bytes(next) - bytes(previous.clockReads),
    acquiredTimespecRoundtripEqual: true, oneIdentityRun: true,
    widths: { seconds: 19, nanoseconds: 9, valueNs: 28, pid: String(identity.pid).length, tid: String(identity.tid).length } };
  vectors.push(record); return record;
}
const normal = SERVER_PROFILE.engineScenes.map((scene) => replacement(scene, 1));
const positiveRight = SERVER_PROFILE.engineScenes.map((scene) => replacement(scene, 2));

// Старый owner меняет N, но повторяет ровно эти raw; порядок и номер run не меняют размер замены.
const stageRuns = { warmup: 4, pilot: 8, aa: 1024, positive: 1024, ab: 1024 };
const stages = {};
for (const [stage, runs] of Object.entries(stageRuns)) {
  let delta = 0, endpoints = 0, repetitions = 0, samples = 0;
  for (const [index, scene] of SERVER_PROFILE.engineScenes.entries()) for (const participant of ['left', 'right']) {
    const multiplier = stage === 'positive' && participant === 'right' ? 2 : 1;
    const count = SERVER_PROFILE.repetitions * (scene.workload === 'stock-c' ? 1 : multiplier);
    const vector = multiplier === 2 ? positiveRight[index] : normal[index];
    delta += runs * count * vector.replacementDeltaBytes;
    endpoints += runs * count * vector.endpointCount;
    repetitions += runs * count; samples += runs;
  }
  delta += samples * sampleIdentityMember;
  stages[stage] = { runs, samples, rawRepetitions: repetitions, endpointCountEachCarrier: endpoints, replacementDeltaEachCarrierBytes: delta };
}
const oldModelText = readFileSync(`${frozen}/bench/profile/server-profile-registration.mjs`, 'utf8');
const oldScopeLiteral = oldModelText.match(/stockCpuScope:\s*('(?:[^'\\]|\\.)*')/);
if (!oldScopeLiteral) throw new Error('не найден прежний stockCpuScope');
const oldScope = Function(`return ${oldScopeLiteral[1]}`)();
const stockScopeGrowth = Math.max(0, Buffer.byteLength(SERVER_PROFILE.stockCpuScope) - Buffer.byteLength(oldScope));

// Добавляем весь текущий protocol/registration, не предполагая размер прежних статических полей.
const fixtureText = readFileSync(`${root}/test/server-profile-contract.test.ts`, 'utf8');
const registrationBegin = fixtureText.indexOf('function registeredRefusal() {');
const registrationEnd = fixtureText.indexOf('\n}\n', registrationBegin);
const registrationBody = fixtureText.slice(fixtureText.indexOf('{', registrationBegin) + 1, registrationEnd);
const registered = Function('SERVER_PROFILE', 'serverProfileDigest', 'clone', 'hash', 'syntheticCpuIdentity', registrationBody)(SERVER_PROFILE, serverProfileDigest, structuredClone, 'a'.repeat(64), identity);
const staticAddition = bytes(SERVER_PROFILE) + bytes(registered.registration);
const totalRuns = Object.values(stageRuns).reduce((a, b) => a + b, 0);
const scopeAddition = totalRuns * 2 * stockScopeGrowth;
// Pilot old-owner units<4000 меняет только operationNs; 24 байта на каждый затронутый Number дают отдельную верхнюю границу.
const pilotNumberAddition = SERVER_PROFILE.pilotRuns * (SERVER_PROFILE.repetitions + 1) * 24;
const delta = Object.values(stages).reduce((sum, stage) => sum + stage.replacementDeltaEachCarrierBytes, 0);
const addedBound = delta + staticAddition + scopeAddition + pilotNumberAddition;
const rawUpper = oldReceipt.raw.bytes + addedBound, journalUpper = oldReceipt.journal.bytes + addedBound;
const reserve = 1_073_741_824;
const fs = statfsSync('/tmp', { bigint: true });
const available = fs.bavail * fs.bsize;
const sourcePaths = ['bench/profile/server-profile-registration.mjs', 'bench/profile/server-profile-contract.mjs', 'bench/profile/server-profile-runner.mjs', 'test/server-profile-contract.test.ts'];
const result = { schema: 1, acquiredAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  runtime: { node: process.version, executable: process.execPath },
  hostResourceSnapshot: { affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1],
    cpuMax: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(), cpuStat: readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').trim() },
  sourceFiles: Object.fromEntries(sourcePaths.map((path) => [path, sha(readFileSync(`${root}/${path}`))])),
  oldInputs: { original, frozen, pins: oldPins, rawBytes: oldReceipt.raw.bytes, journalBytes: oldReceipt.journal.bytes },
  protocolDigest: serverProfileDigest(SERVER_PROFILE), maximumNativeIdentity: identity, vectors, stages,
  sampleCpuClockMemberBytes: sampleIdentityMember,
  endpointCountEachCarrier: Object.values(stages).reduce((a, b) => a + b.endpointCountEachCarrier, 0),
  nativeReplacementDeltaEachCarrierBytes: delta,
  additionsEachCarrier: { fullCurrentProtocolAndRegistrationBytes: staticAddition, stockScopeGrowthBytes: scopeAddition, pilotNumericUpperBytes: pilotNumberAddition },
  upperSyntheticCarrierBytes: { raw: rawUpper, journal: journalUpper, combined: rawUpper + journalUpper },
  reserveBytes: reserve, requiredWithReserveBytes: rawUpper + journalUpper + reserve,
  tmpAvailableBytesSnapshot: String(available), headroomAfterCarriersAndReserveBytes: String(available - BigInt(rawUpper + journalUpper + reserve)),
  scope: 'Верхняя граница успешной существующей synthetic max-N формы после замены CPU/clock fields. Не граница реальной серии: browser/трассы/ошибки/пути регистрации могут иметь другую ширину.',
  actualTimingSamplesObserved: 0, denseCarrierGenerated: false, consumerExecuted: false };
writeFileSync(`${output}/capacity-result.json`, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(result)}\n`);
