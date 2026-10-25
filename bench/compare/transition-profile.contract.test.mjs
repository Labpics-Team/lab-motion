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

async function execute(directory, args, preload) {
  const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []),
    join(repository, 'bench/compare/transition-profile.mjs'), ...args], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
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
