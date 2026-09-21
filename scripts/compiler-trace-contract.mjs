const TRACE_PREFIX = 'tooling-trace ';
const TRACE_KEYS = ['execution', 'goal', 'id', 'owner', 'path', 'refusal'];

export const EXPECTED_COMPILER_TRACE = Object.freeze([
  Object.freeze({
    id: 'nano-static',
    goal: 'static opacity=0.5',
    owner: '@labpics/motion/compiler/runtime',
    path: 'dist/compiler/runtime/index.js',
    execution: 'compiled',
    refusal: null,
  }),
  Object.freeze({
    id: 'nano-dynamic',
    goal: 'dynamic opacity',
    owner: '@labpics/motion/nano',
    path: 'dist/nano/index.js',
    execution: 'runtime',
    refusal: 'opacity is not build-known',
  }),
  Object.freeze({
    id: 'surface-static',
    goal: "static width [240,360], layout='project'",
    owner: '@labpics/motion/compiler/surface',
    path: 'dist/compiler/surface/index.js',
    execution: 'compiled',
    refusal: null,
  }),
  Object.freeze({
    id: 'surface-dynamic',
    goal: "dynamic width endpoint, layout='project'",
    owner: '@labpics/motion/animate',
    path: 'dist/animate/index.js',
    execution: 'runtime',
    refusal: 'endpoint is not build-known',
  }),
  Object.freeze({
    id: 'surface-on-frame',
    goal: "static width, layout='project', onFrame",
    owner: '@labpics/motion/animate',
    path: 'dist/animate/index.js',
    execution: 'runtime',
    refusal: 'onFrame requires runtime observation',
  }),
]);

function fail(message) {
  throw new Error(`compiler tooling trace: ${message}`);
}

export function parseCompilerTrace(stdout) {
  const records = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(TRACE_PREFIX)) continue;
    try {
      records.push(JSON.parse(line.slice(TRACE_PREFIX.length)));
    } catch (error) {
      fail(`невалидный JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records;
}

export function validateCompilerTrace(records) {
  if (records.length !== EXPECTED_COMPILER_TRACE.length) {
    fail(`ожидалось ${EXPECTED_COMPILER_TRACE.length} записей, получено ${records.length}`);
  }

  const actualById = new Map();
  for (const record of records) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      fail('запись должна быть объектом');
    }
    const keys = Object.keys(record).sort();
    if (keys.length !== TRACE_KEYS.length || keys.some((key, index) => key !== TRACE_KEYS[index])) {
      fail(`запись ${String(record.id)} имеет неверные поля: ${keys.join(', ')}`);
    }
    if (typeof record.id !== 'string' || record.id.length === 0) {
      fail('id должен быть непустой строкой');
    }
    if (actualById.has(record.id)) fail(`дублирующий id ${record.id}`);
    actualById.set(record.id, record);
  }

  for (const expected of EXPECTED_COMPILER_TRACE) {
    const actual = actualById.get(expected.id);
    if (actual === undefined) fail(`отсутствует ${expected.id}`);
    for (const key of TRACE_KEYS) {
      if (!Object.is(actual[key], expected[key])) {
        fail(`${expected.id}.${key}: ожидалось ${JSON.stringify(expected[key])}, получено ${JSON.stringify(actual[key])}`);
      }
    }
  }

  return records;
}
