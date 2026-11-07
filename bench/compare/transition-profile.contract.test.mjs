import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

function put(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

function inputPackage(directory, name, fault) {
  const root = join(directory, name);
  mkdirSync(root);
  for (const path of ['scripts', 'bench/compare']) cpSync(join(repository, path), join(root, path), {
    recursive: true, filter: source => !source.split(/[\\/]/).some(part => ['node_modules', 'results', 'evidence'].includes(part)),
  });
  symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction');
  symlinkSync(join(repository, 'bench/compare/node_modules'), join(root, 'bench/compare/node_modules'), 'junction');
  const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repository, encoding: 'utf8' }).trim();
  put(root, '.git', `gitdir: ${gitDirectory}\n`);
  put(root, 'package.json', JSON.stringify({ type: 'module', version: '1.0.0' }));
  // Фикстура входного пакета использует настоящие DOM/WAAPI, а не подмену браузера.
  // Быстрый законный lifecycle не используется как измерение Lab Motion.
  put(root, 'dist/motion/index.js', `export function animate(elements) {
    const animations = elements.map(element => element.animate(
      [{ transform: 'translateX(0px)' }, { transform: 'translateX(300px)' }],
      { duration: 1, fill: 'forwards' }));
    const finished = Promise.all(animations.map(animation => animation.finished));
    return { finished, duration: 1,
      pause() { animations.forEach(animation => animation.pause()); },
      seek(time) { animations.forEach(animation => { animation.currentTime = time${fault === 'seek' ? ' + 1' : ''}; }); },
      stop() { animations.forEach(animation => animation.cancel());
        ${fault === 'cleanup' ? "elements[0].ownerDocument.body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, iterations: Infinity });" : ''}
      }
    };
  }`);
  for (const entry of ['lab', 'lab-native', 'motion', 'gsap', 'anime', 'waapi-control', 'motion-mini', 'anime-waapi']) {
    put(root, `bench/compare/entries/${entry}.entry.mjs`, `import { animate } from '../../../dist/motion/index.js';
export function start(elements) { const run = animate(elements); return { finished: () => run.finished, cancel: () => run.stop() }; }`);
  }
  return root;
}

async function execute(directory, args, preload, runner = join(repository, 'bench/compare/transition-profile.mjs')) {
  const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []),
    runner, ...args], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  return await new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Transition CLI timeout\n${stderr}`)); }, 180_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }); });
  });
}

describe('transition-profile: реальный Chromium и изменяемые внешние входы', () => {
  it('startup diagnostic сохраняет профили, баланс и настоящий lifecycle', { timeout: 180_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'motion-startup-cli-'));
    try {
      const candidate = inputPackage(directory, 'candidate', 'success');
      const output = join(directory, 'output');
      const result = await execute(directory, [candidate, output, 'startup-diagnostic']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(existsSync(join(output, 'summary.json')), false);
      const metadata = JSON.parse(readFileSync(join(output, 'metadata.json'), 'utf8'));
      assert.deepEqual(metadata.scenario.counts, [1000]);
      assert.equal(metadata.scenario.durationMs, 400);
      assert.deepEqual(Object.keys(metadata.adapters), ['lab', 'waapi-ctl']);
      for (let position = 0; position < 4; position++) {
        assert.equal(new Set(metadata.orders.map(order => order[position])).size, 4);
      }
      const rows = readFileSync(join(output, 'samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(rows.length, 16);
      assert.ok(rows.every(row => row.valid && row.effects === 0 && row.endpoint.maxError <= 0.05 && row.offered === 1000 && row.accepted === 1000 && row.completed === 1000));
      const diagnostic = JSON.parse(readFileSync(join(output, 'diagnostic.json'), 'utf8'));
      assert.equal(diagnostic.completedStarts, 16);
      assert.equal(diagnostic.coverage.length, 8);
      for (const coverage of diagnostic.coverage) {
        const profile = JSON.parse(readFileSync(join(output, coverage.profileFile), 'utf8'));
        assert.ok(Array.isArray(profile.nodes));
        assert.equal(coverage.samples, profile.samples?.length ?? 0);
        assert.ok(coverage.startupSamples <= coverage.samples);
        assert.equal(coverage.status, coverage.startupSamples ? 'sampled-startup' : 'inconclusive-no-startup-samples');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  for (const fault of ['ordering', 'label-missing', 'label-renamed', 'label-wrong-last', 'page-setup', 'cdp-session', 'context-close', 'setup-and-close', 'start-response', 'start-and-stop', 'coverage']) it(`сохраняет diagnostic boundary ${fault}`, { timeout: 180_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'motion-startup-boundary-'));
    try {
      const candidate = inputPackage(directory, 'candidate', 'success');
      const output = join(directory, 'output');
      const receipt = join(directory, 'boundary.jsonl');
      const preload = join(directory, 'boundary.mjs');
      if (fault.startsWith('label-')) {
        // Контрпримеры меняют исполняемую копию CLI, а не ожидаемый результат свидетеля.
        const runner = join(candidate, 'bench/compare/transition-profile.mjs');
        const source = readFileSync(runner, 'utf8');
        const directive = '//# sourceURL=motion-startup-${id}.js';
        assert.equal(source.split(directive).length, 2);
        const replacement = fault === 'label-missing' ? '' : fault === 'label-renamed'
          ? '//# sourceURL=renamed-${id}.js'
          : directive + '\\n//# sourceURL=wrong-last.js';
        writeFileSync(runner, source.replace(directive, replacement));
      }
      // Обёртки вызывают настоящие границы браузера; отказывает только выбранный ответ.
      writeFileSync(preload, `import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
const require = createRequire(${JSON.stringify(join(repository, 'bench/compare/package.json'))});
const { chromium } = require('playwright');
const fault = ${JSON.stringify(fault)}, receipt = ${JSON.stringify(receipt)};
const record = event => appendFileSync(receipt, JSON.stringify({ event }) + '\\n');
const witness = ['ordering', 'coverage'].includes(fault);
const labelControl = witness || fault.startsWith('label-');
const launch = chromium.launch.bind(chromium);
let armed = true, observation = 0;
chromium.launch = async (...args) => {
  const browser = await launch(...args), newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const index = observation++;
    const conditions = JSON.parse(readFileSync(${JSON.stringify(join(output, 'metadata.json'))}, 'utf8')).orders.flat();
    const context = await newContext(...args), close = context.close.bind(context), newPage = context.newPage.bind(context), session = context.newCDPSession.bind(context);
    let observedPage, injections = 0;
    context.close = async (...args) => {
      if (witness) {
        assert.equal(injections, 1);
        const events = await observedPage.evaluate(() => window.__startupWitness);
        appendFileSync(receipt, JSON.stringify({ index, events }) + '\\n');
      }
      await close(...args); record('context-closed');
      if (armed && ['context-close', 'setup-and-close'].includes(fault)) { armed = false; throw new Error('FAULT_CONTEXT_CLOSE'); }
    };
    context.newPage = async (...args) => {
      const page = await newPage(...args), goto = page.goto.bind(page), addScriptTag = page.addScriptTag.bind(page);
      observedPage = page;
      if (labelControl) page.addScriptTag = async (...args) => {
        assert.equal(++injections, 1);
        const id = conditions[index].split(':')[0];
        // Проверяем последний эффективный URL в настоящем аргументе загрузки.
        const directives = [...args[0].content.matchAll(/^[ \\t]*\\/\\/[#@][ \\t]*sourceURL[ \\t]*=[ \\t]*(\\S+)[ \\t]*$/gm)];
        assert.equal(directives.at(-1)?.[1], 'motion-startup-' + id + '.js', 'SOURCE_URL_BOUNDARY');
        const result = await addScriptTag(...args);
        if (!witness) return result;
        // Синхронный свидетель в том же realm: обёртка вызывает настоящий адаптер.
        await page.evaluate(() => {
          window.__startupWitness = [];
          const adapter = window.__adapterModule;
          window.__adapterModule = { ...adapter, start(...args) {
            window.__startupWitness.push('adapter-entry');
            try { return adapter.start(...args); }
            finally { window.__startupWitness.push('adapter-exit'); }
          } };
        });
        return result;
      };
      page.goto = async (...args) => {
        const result = await goto(...args);
        if (armed && ['page-setup', 'setup-and-close'].includes(fault)) {
          if (fault === 'page-setup') armed = false;
          throw new Error('FAULT_PAGE_SETUP');
        }
        return result;
      };
      return page;
    };
    context.newCDPSession = async (...args) => {
      const cdp = await session(...args);
      if (armed && fault === 'cdp-session') { armed = false; throw new Error('FAULT_CDP_SESSION'); }
      const send = cdp.send.bind(cdp);
      cdp.send = async (method, ...args) => {
        // Маркер отправки до настоящего stop; ack — только после настоящего start.
        // Никакого сравнения часов или порядка доставки console-событий.
        if (witness && method === 'Profiler.stop') await observedPage.evaluate(() => window.__startupWitness.push('profiler-stop-send'));
        const result = await send(method, ...args);
        if (method === 'Profiler.start') {
          if (witness) await observedPage.evaluate(() => window.__startupWitness.push('profiler-start-ack'));
          record('profiler-started');
          if (armed && ['start-response', 'start-and-stop'].includes(fault)) { armed = false; throw new Error('FAULT_START_RESPONSE'); }
        }
        if (method === 'Profiler.stop') {
          record('profiler-stopped');
          if (fault === 'start-and-stop') throw new Error('FAULT_STOP_RESPONSE');
          if (fault === 'coverage') {
            // Данные профиля детерминированы; настоящие запуск, остановка и жизненный цикл выполняются.
            const metadata = JSON.parse(readFileSync(${JSON.stringify(join(output, 'metadata.json'))}, 'utf8'));
            const id = metadata.orders.flat()[index].split(':')[0];
            const frame = (functionName, url = '') => ({ functionName, url, scriptId: '1', lineNumber: 0, columnNumber: 0 });
            const firstProfile = metadata.orders.flat().findIndex(value => value.endsWith(':profiled')) === index;
            result.profile = { startTime: 0, endTime: 4, timeDeltas: [1,1,1,1], samples: firstProfile ? [3,4,5,6] : [4,5,6,5], nodes: [
              { id: 1, callFrame: frame('(root)'), children: [2,4,5] },
              { id: 2, callFrame: frame('startupDiagnosticStart'), children: [3] },
              { id: 3, callFrame: frame('start', 'motion-startup-' + id + '.js') },
              { id: 4, callFrame: frame('start', 'motion-startup-' + id + '.js'), children: [6] },
              { id: 5, callFrame: frame('unrelated', 'other.js') },
              { id: 6, callFrame: frame('startupDiagnosticStart') },
            ] };
          }
        }
        return result;
      };
      return cdp;
    };
    return context;
  };
  return browser;
};`);
      const result = await execute(directory, [candidate, output, 'startup-diagnostic'], preload,
        fault.startsWith('label-') ? join(candidate, 'bench/compare/transition-profile.mjs') : undefined);
      const receipts = readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const events = receipts.map(row => row.event);
      assert.ok(events.includes('context-closed'));
      if (['ordering', 'coverage'].includes(fault)) {
        assert.equal(result.code, 0, result.stderr);
        const metadata = JSON.parse(readFileSync(join(output, 'metadata.json'), 'utf8'));
        const observations = metadata.orders.flat();
        const witnesses = receipts.filter(row => row.events);
        assert.equal(witnesses.length, observations.length);
        for (const [index, condition] of observations.entries()) {
          const rows = witnesses.filter(row => row.index === index);
          assert.equal(rows.length, 1);
          assert.deepEqual(rows[0].events, condition.endsWith(':profiled')
            ? ['profiler-start-ack', 'adapter-entry', 'adapter-exit', 'profiler-stop-send']
            : ['adapter-entry', 'adapter-exit']);
        }
      }
      if (fault === 'coverage') {
        assert.equal(result.code, 0, result.stderr);
        const diagnostic = JSON.parse(readFileSync(join(output, 'diagnostic.json'), 'utf8'));
        const first = diagnostic.coverage[0];
        assert.equal(first.samples, 4);
        assert.equal(first.startupSamples, 1); // Постоянный нулевой результат классификатора детерминированно нарушает проверку.
        assert.equal(first.status, 'sampled-startup');
        assert.equal(JSON.parse(readFileSync(join(output, first.profileFile), 'utf8')).samples.length, 4);
        for (const negative of diagnostic.coverage.slice(1)) {
          assert.equal(negative.samples, 4);
          assert.equal(negative.startupSamples, 0);
          assert.equal(negative.status, 'inconclusive-no-startup-samples');
        }
      } else if (fault !== 'ordering') {
        assert.notEqual(result.code, 0);
        assert.equal(existsSync(join(output, 'diagnostic.json')), false);
        const failures = readFileSync(join(output, 'failures.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const expected = fault === 'setup-and-close' ? ['page-setup', 'context-close'] : fault === 'start-and-stop' ? ['profiler-start', 'profiler-stop-after-failure'] : [fault.startsWith('label-') ? 'page-setup' : fault === 'start-response' ? 'profiler-start' : fault];
        assert.deepEqual(failures.map(row => row.stage), expected);
        assert.ok(failures.every(row => row.round === 0 && row.count === 1000 && row.condition && row.offered === 1000));
        for (const row of failures) assert.ok(result.stderr.includes(row.error.split('\n')[0]));
        if (fault.startsWith('label-')) assert.ok(result.stderr.includes('SOURCE_URL_BOUNDARY'));
        if (fault === 'context-close') {
          const rows = readFileSync(join(output, 'samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
          assert.ok(rows.at(-1).valid);
          assert.equal(failures[0].completed, 1000);
        }
        if (fault.startsWith('start-')) {
          assert.ok(events.includes('profiler-started') && events.includes('profiler-stopped'));
          const failed = failures[0];
          if (fault === 'start-response') assert.ok(existsSync(join(output, failed.round + '-' + failed.id + '.cpuprofile')));
          else assert.equal(failures[1].coverage.status, 'unrecoverable-profiler-stop');
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  for (const fault of ['success', 'seek', 'cleanup', 'adapter', 'dist']) it(`проверяет ${fault} через CLI`, { timeout: 180_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'motion-transition-cli-'));
    try {
      const baseline = inputPackage(directory, 'baseline', 'success');
      const candidate = inputPackage(directory, 'candidate', fault);
      const output = join(directory, 'output');
      let preload, mutationTarget, beforeMutation;
      if (fault === 'adapter' || fault === 'dist') {
        preload = join(directory, 'mutate.mjs');
        const target = fault === 'adapter' ? join(output, 'adapters/lab.js') : join(candidate, 'dist/motion/index.js');
        mutationTarget = target;
        const mutationReceipt = join(directory, 'mutation.json');
        // Запись metadata завершает фиксацию identities: изменение строго после неё.
        writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const original = fs.writeFileSync;
fs.writeFileSync = function(file, ...args) {
  const result = Reflect.apply(original, this, [file, ...args]);
  if (typeof file === 'string' && resolve(file) === ${JSON.stringify(join(output, 'metadata.json'))}) {
    const target = ${JSON.stringify(target)};
    const before = fs.readFileSync(target, 'utf8');
    fs.appendFileSync(target, '\\n// deterministic mutation\\n');
    Reflect.apply(original, fs, [${JSON.stringify(mutationReceipt)}, JSON.stringify({ target, before })]);
  }
  return result;
};
syncBuiltinESMExports();`);
      }
      const result = await execute(directory, [candidate, output, 'js-pair', baseline], preload);
      if (mutationTarget) {
        const mutation = JSON.parse(readFileSync(join(directory, 'mutation.json'), 'utf8'));
        assert.equal(mutation.target, mutationTarget);
        beforeMutation = mutation.before;
        assert.equal(readFileSync(mutationTarget, 'utf8'), beforeMutation + '\n// deterministic mutation\n');
      }
      const semantics = JSON.parse(readFileSync(join(output, 'paired-semantics.json'), 'utf8'));
      if (fault === 'success') {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(semantics.exact, true);
        const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
        assert.equal(summary.length, 6);
        const rows = readFileSync(join(output, 'samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(rows.length, 120);
        assert.ok(rows.every(row => row.valid && row.effects === 0 && row.endpoint.maxError <= 0.05));
      } else {
        assert.notEqual(result.code, 0);
        assert.equal(existsSync(join(output, 'summary.json')), false);
        if (fault === 'seek') {
          assert.equal(semantics.exact, false);
        } else if (fault === 'cleanup') {
          const row = JSON.parse(readFileSync(join(output, 'samples.jsonl'), 'utf8').trim().split('\n').at(-1));
          assert.ok(row.effects > 0);
          assert.equal(row.valid, false);
        } else {
          assert.equal(semantics.exact, true);
          assert.ok(mutationTarget);
          assert.equal(typeof beforeMutation, 'string');
          const rows = readFileSync(join(output, 'samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
          assert.equal(rows.length, 120);
          assert.ok(rows.every(row => row.valid && row.effects === 0 && row.endpoint.maxError <= 0.05));
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
