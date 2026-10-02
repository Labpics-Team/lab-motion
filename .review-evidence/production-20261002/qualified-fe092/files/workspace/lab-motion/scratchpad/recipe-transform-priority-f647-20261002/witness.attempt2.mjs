import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const subject = JSON.parse(readFileSync(new URL('./subject.before.json', import.meta.url), 'utf8'));
const bundle = readFileSync(new URL('./scope-recipes.before.js', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
if (sha256(bundle) !== subject.receipt.bundleSha256) throw new Error('Frozen actual bundle identity mismatch');
const server = createServer((req, res) => {
  if (req.url === '/scope-recipes.before.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle);
  else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html><head></head><body></body></html>');
});
let browser, report;
const started = Date.now();
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const served = await page.request.get(new URL('/scope-recipes.before.js', page.url()).href);
  const servedSha256 = sha256(await served.body());
  if (servedSha256 !== subject.receipt.bundleSha256) throw new Error('Served actual bundle identity mismatch');
  const cases = await page.evaluate(async () => {
    const recipes = await import('/scope-recipes.before.js');
    const results = [];
    for (const family of ['sheet', 'pager']) {
      for (const initial of ['important', 'plain', 'none', 'absent']) {
        document.body.innerHTML = '<section></section>';
        const root = document.querySelector('section');
        root.innerHTML = family === 'sheet'
          ? '<button data-sheet-handle>Положение</button><div data-sheet-panel></div>'
          : '<button data-pager-handle>Страница</button><div data-pager-viewport style="width:240px;overflow:hidden"><div data-pager-track style="display:flex"><div data-page style="flex:0 0 100%">Первая</div><div data-page style="flex:0 0 100%">Вторая</div></div></div>';
        const target = root.querySelector(family === 'sheet' ? '[data-sheet-panel]' : '[data-pager-track]');
        target.id = 'transform-owner';
        const translate = value => `translate${family === 'sheet' ? 'Y' : 'X'}(${value}px)`;
        if (initial !== 'absent') target.style.setProperty('transform', initial === 'none' ? 'none' : translate(17), initial === 'important' ? 'important' : '');
        const read = () => {
          const matrix = new DOMMatrixReadOnly(getComputedStyle(target).transform);
          return { value: target.style.getPropertyValue('transform'), priority: target.style.getPropertyPriority('transform'),
            present: Array.from(target.style).includes('transform'), pixel: family === 'sheet' ? matrix.m42 : matrix.m41 };
        };
        const before = read();
        const consumer = family === 'sheet'
          ? recipes.mountCompositorSheet(root, { snapPoints: [0, 120], motion: 'none' })
          : recipes.mountCompositorPager(root, { motion: 'none' });
        consumer.select(1);
        const moved = { ...read(), selected: consumer.selected };
        const stylesheet = document.createElement('style');
        stylesheet.textContent = `#transform-owner { transform: ${translate(99)}${initial === 'important' ? ' !important' : ''}; }`;
        document.head.append(stylesheet);
        consumer.destroy(); consumer.destroy();
        const after = read();
        const expectedPixel = initial === 'absent' ? 99 : initial === 'none' ? 0 : 17;
        const checks = {
          progress: moved.selected === 1 && moved.pixel === (family === 'sheet' ? 120 : -240),
          exactValue: after.value === before.value,
          exactPriority: after.priority === before.priority,
          exactPresence: after.present === before.present,
          renderedRestored: after.pixel === expectedPixel,
          noEffects: target.getAnimations().length === 0,
        };
        results.push({ family, initial, before, moved, after, expectedPixel, checks });
        stylesheet.remove(); root.remove();
      }
    }
    return results;
  });
  report = { status: cases.every(result => Object.values(result.checks).every(Boolean)) ? 'GREEN' : 'RED',
    subject, servedSha256, browserVersion: browser.version(), executablePath: chromium.executablePath(),
    elapsedMs: Date.now() - started, cases };
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(new URL('./red2.observations.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.status === 'RED' ? 1 : 0;
} catch (error) {
  const failure = { status: 'HARNESS_ERROR', error: String(error?.stack ?? error), subject, elapsedMs: Date.now() - started };
  writeFileSync(new URL('./red2.error.json', import.meta.url), JSON.stringify(failure, null, 2) + '\n');
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 2;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify({ terminal: true, browserClosed: true, serverClosed: true, elapsedMs: Date.now() - started }));
}
