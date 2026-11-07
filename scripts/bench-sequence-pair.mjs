import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { cpus, platform } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';
import { hashFileTree } from '../bench/compare/provenance.mjs';
import { summarizeDistribution } from './bench-support.mjs';

// Сравниваются готовые dist: сборка и установка не входят в измеряемое время.
// Для A/A передайте один и тот же dist в обе позиции.
export function parseSequencePairArgs(args) {
  if (args.length !== 4 && args.length !== 6 || args[0] !== '--baseline' || args[2] !== '--current' ||
      args.length === 6 && (args[4] !== '--browser' || !['chromium', 'firefox', 'webkit'].includes(args[5]))) {
    throw new Error('Usage: --baseline <dist> --current <dist> [--browser chromium|firefox|webkit]');
  }
  return { roots: { baseline: realpathSync(args[1]), current: realpathSync(args[3]) }, browser: args[5] ?? 'chromium' };
}

async function measure(page, name, kind, count) {
  return page.evaluate(async ({ name, kind, count }) => {
    const api = await import(`/${name}/motion/index.js`);
    const element = document.createElement('div');
    element.style.cssText = 'position:absolute;height:1px;width:0;padding:0;border:0;box-sizing:content-box';
    document.body.append(element);
    const steps = kind === 'sequence' ? Array.from({ length: count }, (_, index) => [
      element, { width: index + 1 }, { duration: 10, ease: 'linear' },
    ]) : undefined;
    const values = steps ? undefined : Array.from({ length: count + 1 }, (_, index) => index);
    let run;
    try {
      const start = performance.now();
      run = steps ? api.sequence(steps) : api.animate(element, { width: values }, { duration: count * 10, ease: 'linear' });
      run.pause();
      const startupMs = performance.now() - start;
      const seekBatchMs = [];
      let checked = 0;
      for (let batch = 0; batch < 20; batch++) {
        const before = performance.now();
        for (let index = 0; index < 200; index++) {
          const time = ((index * 7919 + batch * 541) % (count - 1)) * 10 + 5;
          run.seek(time);
          // Реальная layout-геометрия, не строка, записанная самим движком.
          const width = element.getBoundingClientRect().width;
          if (width !== time / 10) throw new Error(`Incorrect geometry: ${width} at ${time}`);
          checked++;
        }
        seekBatchMs.push(performance.now() - before);
      }
      const cleanup = performance.now();
      run.finish();
      const result = await run.finished;
      if (result.status !== 'finished' || element.getBoundingClientRect().width !== count || element.getAnimations().length !== 0)
        throw new Error('Incomplete playback or cleanup');
      element.remove();
      return { startupMs, seekBatchMs, cleanupMs: performance.now() - cleanup,
        totalMs: performance.now() - start, checked, outcome: result.status };
    } finally { run?.stop(); element.remove(); }
  }, { name, kind, count });
}

export async function runSequencePair({ roots, browser: engine }) {
  const before = Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, hashFileTree(root)]));
  for (const root of Object.values(roots)) readFileSync(resolve(root, 'motion/index.js'));
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body></body></html>'); return; }
      const [, name, ...parts] = pathname.split('/');
      const root = roots[name];
      if (!root) throw new Error('Unknown artifact');
      const file = realpathSync(resolve(root, ...parts));
      const local = relative(root, file);
      if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Outside artifact');
      const content = readFileSync(file);
      response.setHeader('Content-Type', 'text/javascript'); response.end(content);
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await ({ chromium, firefox, webkit })[engine].launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const rows = [];
    for (const kind of ['sequence', 'keyframes']) for (const count of [64, 1024, 10000]) {
      const rounds = [];
      for (let round = -2; round < 8; round++) {
        // Каждые два измерительных раунда образуют ABBA либо BAAB.
        const order = (round + Math.floor(round / 2)) % 2 === 0 ? ['baseline', 'current'] : ['current', 'baseline'];
        const samples = {};
        for (const name of order) samples[name] = await measure(page, name, kind, count);
        assert.equal(samples.baseline.checked, samples.current.checked);
        if (round >= 0) rounds.push({ order, samples });
      }
      const summary = name => ({
        startupMs: summarizeDistribution(rounds.map(row => row.samples[name].startupMs)),
        seek200Ms: summarizeDistribution(rounds.flatMap(row => row.samples[name].seekBatchMs)),
        totalMs: summarizeDistribution(rounds.map(row => row.samples[name].totalMs)),
      });
      rows.push({ kind, count, baseline: summary('baseline'), current: summary('current'), rounds });
      process.stderr.write(`${kind}: ${count} segments complete\n`);
    }
    for (const [name, root] of Object.entries(roots)) assert.deepEqual(hashFileTree(root), before[name], 'Artifact changed during measurement');
    return { schemaVersion: 1, createdAt: new Date().toISOString(), browser: { engine, version: browser.version() },
      environment: { node: process.version, platform: platform(), cpu: cpus()[0]?.model },
      artifacts: before, rows,
      interpretation: 'Descriptive paired observations of warm root startup, 4000 seeks with real DOM layout, finish and cleanup. Not animation FPS, import latency, or a competitor comparison.' };
  } finally {
    try { await browser?.close(); } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await runSequencePair(parseSequencePairArgs(process.argv.slice(2))))}\n`); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
