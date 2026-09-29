/** Предметные различители ./bindings. Рабочие src/dist не изменяются. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'src/bindings/index.ts');
const testPath = 'test/semantic-motion-binding.test.ts';
const source = readFileSync(sourcePath, 'utf8');
const cases = [
  ['restart-unchanged', 'if (previousGoals && propertyKeys!', 'if (false && propertyKeys!', 'обновляет только изменившиеся визуальные роли'],
  ['mutable-goal', 'goals.push(Object.freeze(goal))', 'goals.push(goal)', 'снимает неизменяемые цели'],
  ['aliased-goal', 'goals.push(Object.freeze(goal))', 'goals.push(input as MotionBindingGoal)', 'снимает неизменяемые цели'],
  ['partial-cleanup', 'for (const effect of effects) {', 'for (const effect of effects.slice(0, 1)) {', 'destroy отменяет всё несмотря на исключение'],
  ['cancel-successor', 'protectedHandles.has(effect.identity) || ', '', 'переданный в следующий результат тот же handle'],
  ['overwrite-destroy', "if (state === 'active') state = outcome;", 'state = outcome;', 'ошибка после destroy не перезаписывает'],
  ['recursive-project', "if (projecting) throw new MotionParamError('LM181');", '', 'проекция не может рекурсивно записывать'],
  ['read-after-revoke', "if (state !== 'active') return true;", '', 'отзыв во время проверки принадлежности поля'],
];
const work = mkdtempSync(join(tmpdir(), 'motion-binding-mutations-'));
const digest = text => createHash('sha256').update(text).digest('hex');
try {
  for (const dir of ['src/bindings', 'test']) mkdirSync(join(work, dir), { recursive: true });
  copyFileSync(join(root, 'src/errors.ts'), join(work, 'src/errors.ts'));
  copyFileSync(join(root, testPath), join(work, testPath));
  symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'junction');
  writeFileSync(join(work, 'package.json'), '{"type":"module"}');
  writeFileSync(join(work, 'vitest.config.mjs'), 'export default {test:{include:["test/*.test.ts"],environment:"node"}};');
  const reportFile = join(work, 'result.json');
  function execute(text) {
    writeFileSync(join(work, 'src/bindings/index.ts'), text);
    rmSync(reportFile, { force: true });
    const child = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', work,
      '--config', join(work, 'vitest.config.mjs'), '--maxWorkers=1', '--reporter=json', '--outputFile', reportFile],
    { cwd: work, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.signal, null, 'Таймаут не является обнаруженным мутантом');
    assert.equal(child.error, undefined);
    const result = JSON.parse(readFileSync(reportFile, 'utf8'));
    const tests = result.testResults.flatMap(suite => suite.assertionResults);
    assert(tests.length > 0 && tests.every(test => ['passed', 'failed'].includes(test.status)), 'Набор не должен терять или пропускать тесты');
    return { child, result, tests };
  }
  const baseline = execute(source);
  assert.equal(baseline.child.status, 0, baseline.child.stdout + baseline.child.stderr);
  assert.equal(baseline.result.numFailedTests, 0);
  const records = [];
  for (const [name, before, after, witness] of cases) {
    assert.equal(source.split(before).length, 2, `Мутант ${name}: требуется один точный участок`);
    const candidate = execute(source.replace(before, after));
    assert.equal(candidate.child.status, 1, `Мутант ${name} не дал ожидаемый отказ теста`);
    assert.equal(candidate.tests.length, baseline.tests.length, 'Изменился проверяемый набор');
    assert.deepEqual(candidate.tests.map(test => test.fullName), baseline.tests.map(test => test.fullName));
    const target = candidate.tests.filter(test => test.fullName.includes(witness));
    assert.equal(target.length, 1, `Неоднозначный witness ${name}`);
    assert.equal(target[0].status, 'failed', `Выжил целевой witness ${name}`);
    assert(target[0].failureMessages.some(message => message.includes('AssertionError')), 'Импорт/синтаксис не являются предметным RED');
    records.push({ name, witness: target[0].fullName, failedTests: candidate.result.numFailedTests, killed: true });
  }
  const restored = execute(source);
  assert.equal(restored.child.status, 0, 'Положительный контроль после мутаций обязан пройти');
  assert.equal(readFileSync(sourcePath, 'utf8'), source, 'Исходник checkout не изменяется');
  console.log(JSON.stringify({ sourceSHA256: digest(source), testSHA256: digest(readFileSync(join(root, testPath))),
    node: process.version, baselineTests: baseline.tests.length, restoredTests: restored.tests.length, records }));
} finally { rmSync(work, { recursive: true, force: true }); }
