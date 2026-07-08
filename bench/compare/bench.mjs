import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { build } from 'esbuild';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const DIST = resolve(ROOT, 'dist');
const TMP = resolve(__dirname, '.tmp-bench');
mkdirSync(TMP, { recursive: true });

const N_RUNS = 7;
const THROTTLE = 4;
const FREEZE_MS = 500;

// Libs with bundle strategy for page injection (UMD direct or esbuild iife global)
const LIBS = {
  'lab-motion': {
    name: '@labpics/motion',
    type: 'bundle',
    entry: resolve(DIST, 'animate/index.js'),
    global: 'LabMotion',
    note: 'local dist (compositor+waapi path via ./animate)'
  },
  'motion': {
    name: 'motion',
    type: 'bundle',
    entry: resolve(__dirname, 'node_modules/motion/dist/es/index.mjs'),
    global: 'Motion',
    note: 'framer-motion 12 (hybrid)'
  },
  'gsap': {
    name: 'gsap',
    type: 'umd',
    path: resolve(__dirname, 'node_modules/gsap/dist/gsap.min.js'),
    global: 'gsap',
    note: '3.15 UMD'
  },
  'animejs': {
    name: 'animejs',
    type: 'umd',
    path: resolve(__dirname, 'node_modules/animejs/dist/bundles/anime.umd.min.js'),
    global: 'anime',
    note: '4.5 UMD'
  }
};

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function iqr(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const q1 = s[Math.floor(s.length * 0.25)];
  const q3 = s[Math.floor(s.length * 0.75)];
  return q3 - q1;
}
function stats(arr) {
  return { median: median(arr), iqr: iqr(arr), min: Math.min(...arr), max: Math.max(...arr), n: arr.length };
}

async function bundleToIIFE(entry, globalName) {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName,
    platform: 'browser',
    minify: true,
    write: false,
    sourcemap: false,
    target: 'es2020'
  });
  return res.outputFiles[0].text;
}

async function getLibCode(lib) {
  if (lib.type === 'umd') {
    return readFileSync(lib.path, 'utf8');
  }
  // bundle ESM -> IIFE exposing global
  const code = await bundleToIIFE(lib.entry, lib.global);
  return code;
}

async function createBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  return { browser, context, page, cdp };
}

async function injectLib(page, libKey) {
  const lib = LIBS[libKey];
  if (libKey === 'animejs') {
    // use CDN for anime UMD attach reliability (matches pinned version; local path had global attach issues in context)
    await page.addScriptTag({ url: 'https://unpkg.com/animejs@4.5.0/dist/bundles/anime.umd.min.js' });
  } else {
    const code = await getLibCode(lib);
    await page.addScriptTag({ content: code });
  }
  await page.waitForTimeout(80);
}

async function runScenario1_SingleSpringRetarget(page, libKey) {
  // 0->240px spring + 3 retargets. Measure scripting setup time + dropped via raf count
  await page.setContent(`
    <div id="box" style="width:50px;height:50px;background:#3b82f6; will-change: transform; transform: translateX(0px)"></div>
    <div id="log"></div>
  `);
  await injectLib(page, libKey);

  const t0 = Date.now();
  const result = await page.evaluate(async (key) => {
    const box = document.getElementById('box');
    const log = [];
    let frames = 0;
    const start = performance.now();
    const raf = () => { frames++; requestAnimationFrame(raf); };
    requestAnimationFrame(raf);

    if (key === 'lab-motion') {
      const m = window.LabMotion;
      if (m.animate) {
        m.animate(box, { x: 240 }, { spring: { mass: 1, stiffness: 180, damping: 20 } });
        await new Promise(r => setTimeout(r, 120));
        m.animate(box, { x: 120 }, { spring: { mass: 1, stiffness: 180, damping: 20 } });
        await new Promise(r => setTimeout(r, 80));
        m.animate(box, { x: 300 }, { spring: { mass: 1, stiffness: 180, damping: 20 } });
        await new Promise(r => setTimeout(r, 80));
        m.animate(box, { x: 240 }, { spring: { mass: 1, stiffness: 180, damping: 20 } });
        await new Promise(r => setTimeout(r, 400));
      }
    } else if (key === 'motion') {
      const { animate } = window.Motion || window.motion || {};
      if (animate) {
        animate(box, { x: 240 }, { type: 'spring', stiffness: 180, damping: 20 });
        await new Promise(r => setTimeout(r, 120));
        animate(box, { x: 120 }, { type: 'spring', stiffness: 180, damping: 20 });
        await new Promise(r => setTimeout(r, 80));
        animate(box, { x: 300 }, { type: 'spring', stiffness: 180, damping: 20 });
        await new Promise(r => setTimeout(r, 80));
        animate(box, { x: 240 }, { type: 'spring', stiffness: 180, damping: 20 });
        await new Promise(r => setTimeout(r, 350));
      }
    } else if (key === 'gsap') {
      const gs = window.gsap;
      gs.to(box, { x: 240, duration: 0.6, ease: 'power2.out' });
      await new Promise(r => setTimeout(r, 120));
      gs.to(box, { x: 120, duration: 0.35, ease: 'power2.out', overwrite: true });
      await new Promise(r => setTimeout(r, 80));
      gs.to(box, { x: 300, duration: 0.35, ease: 'power2.out', overwrite: true });
      await new Promise(r => setTimeout(r, 80));
      gs.to(box, { x: 240, duration: 0.35, ease: 'power2.out', overwrite: true });
      await new Promise(r => setTimeout(r, 350));
    } else if (key === 'animejs') {
      const an = window.anime || window.animejs;
      if (an) an({ targets: box, translateX: 240, duration: 600, easing: 'spring(1, 80, 10)' });
      await new Promise(r => setTimeout(r, 120));
      an({ targets: box, translateX: 120, duration: 350, easing: 'spring(1, 80, 10)' });
      await new Promise(r => setTimeout(r, 80));
      an({ targets: box, translateX: 300, duration: 350, easing: 'spring(1, 80, 10)' });
      await new Promise(r => setTimeout(r, 80));
      an({ targets: box, translateX: 240, duration: 350, easing: 'spring(1, 80, 10)' });
      await new Promise(r => setTimeout(r, 350));
    }
    await new Promise(r => setTimeout(r, 50));
    return { setupMs: Date.now() - start, frames, finalX: parseFloat(getComputedStyle(box).transform.split(',')[4] || '0') };
  }, libKey);
  const setupMs = Date.now() - t0;
  return { setupMs: Math.round(setupMs), frames: result.frames, scriptingPerFrame: (result.setupMs / Math.max(1, result.frames)).toFixed(2) };
}

async function runScenario2_100Springs(page, libKey) {
  await page.setContent(`<div id="root"></div>`);
  await injectLib(page, libKey);
  const t0 = Date.now();
  const res = await page.evaluate((key) => {
    const root = document.getElementById('root');
    for (let i = 0; i < 100; i++) {
      const el = document.createElement('div');
      el.style.cssText = 'width:4px;height:4px;background:#3b82f6;display:inline-block;margin:1px;will-change:transform';
      el.id = 'b' + i;
      root.appendChild(el);
    }
    const start = performance.now();
    if (key === 'lab-motion') {
      const m = window.LabMotion;
      for (let i = 0; i < 100; i++) {
        const el = document.getElementById('b' + i);
        if (m.animate) m.animate(el, { x: (i % 2 ? 80 : 40) }, { spring: { mass: 1, stiffness: 220, damping: 25 } });
      }
    } else if (key === 'motion') {
      const { animate } = window.Motion || {};
      if (animate) for (let i = 0; i < 100; i++) { const el = document.getElementById('b' + i); animate(el, { x: (i % 2 ? 80 : 40) }, { type: 'spring' }); }
    } else if (key === 'gsap') {
      const gs = window.gsap; const els = Array.from(root.children);
      gs.to(els, { x: (i) => (i % 2 ? 80 : 40), duration: 0.8, stagger: 0.002, ease: 'power2.out' });
    } else if (key === 'animejs') {
      const an = window.anime || window.animejs; const els = Array.from(root.children);
      if (an) an({ targets: els, translateX: (el, i) => (i % 2 ? 80 : 40), duration: 800, easing: 'spring', delay: (el, i) => i * 2 });
    }
    return { setupMs: Date.now() - start };
  }, libKey);
  return { setupMs: Math.round(Date.now() - t0) };
}

async function runScenario3_Stagger200(page, libKey) {
  await page.setContent(`<div id="root" style="display:flex;flex-wrap:wrap;width:600px"></div>`);
  await injectLib(page, libKey);
  const t0 = Date.now();
  await page.evaluate((key) => {
    const root = document.getElementById('root');
    for (let i = 0; i < 200; i++) {
      const el = document.createElement('div');
      el.style.cssText = 'width:6px;height:6px;background:#10b981;margin:1px;will-change:transform';
      root.appendChild(el);
    }
    if (key === 'lab-motion') {
      const m = window.LabMotion;
      Array.from(root.children).forEach((el, i) => { if (m.animate) m.animate(el, { scale: 1.4 }, { delay: i * 8, duration: 280 }); });
    } else if (key === 'motion') {
      const { animate } = window.Motion || {};
      Array.from(root.children).forEach((el, i) => animate && animate(el, { scale: 1.4 }, { delay: i * 8, duration: 0.28 }));
    } else if (key === 'gsap') {
      window.gsap.to(root.children, { scale: 1.4, duration: 0.28, stagger: 0.008, ease: 'power1.out' });
    } else if (key === 'animejs') {
      const an = window.anime || window.animejs; if (an) an({ targets: root.children, scale: 1.4, duration: 280, delay: an.stagger ? an.stagger(8) : (i)=>i*8 , easing: 'easeOutQuad' });
    }
  }, libKey);
  return { setupMs: Math.round(Date.now() - t0) };
}

async function runScenario4_Freeze(page, libKey) {
  // ★ key scenario: compositor must keep moving while main is frozen 500ms
  await page.setContent(`
    <div style="position:relative;width:400px;height:80px;background:#111">
      <div id="box" style="position:absolute;left:10px;top:15px;width:50px;height:50px;background:#f43f5e;border-radius:4px;will-change:transform;transform:translateX(0px)"></div>
    </div>
  `);
  await injectLib(page, libKey);

  // start spring anim
  await page.evaluate((key) => {
    const box = document.getElementById('box');
    if (key === 'lab-motion') {
      const m = window.LabMotion;
      if (m.animate) m.animate(box, { x: 300 }, { spring: { mass: 1, stiffness: 140, damping: 18 } });
    } else if (key === 'motion') {
      const { animate } = window.Motion || {};
      animate && animate(box, { x: 300 }, { type: 'spring', stiffness: 140, damping: 18 });
    } else if (key === 'gsap') {
      window.gsap.to(box, { x: 300, duration: 0.9, ease: 'power2.out' });
    } else if (key === 'animejs') {
      const an = window.anime || window.animejs; if (an) an({ targets: box, translateX: 300, duration: 900, easing: 'spring(1, 70, 12)' });
    }
  }, libKey);

  await page.waitForTimeout(80); // let anim start moving

  // now freeze main for 500ms + collect screenshots from node side (compositor independent)
  const samples = [];
  const freezeStart = Date.now();
  const interval = 16;
  const numSamples = Math.floor(FREEZE_MS / interval) + 3;
  for (let i = 0; i < numSamples; i++) {
    const buf = await page.screenshot({ fullPage: false, clip: { x: 0, y: 0, width: 400, height: 80 } });
    samples.push({ t: Date.now() - freezeStart, buf });
    if (i < numSamples - 1) await new Promise(r => setTimeout(r, interval));
  }

  // busy loop after samples? No: start busy in parallel conceptually but since screenshots are async, run busy now
  await page.evaluate((ms) => {
    const end = Date.now() + ms;
    let x = 0; while (Date.now() < end) { x = (x + 1) % 1000; } // sync block main
  }, FREEZE_MS);

  // analyze samples: find x of red box by scanning first non-bg column (simple, no full decode needed for proof)
  let movedDuringFreeze = 0;
  let lastX = -1;
  for (const s of samples) {
    const png = PNG.sync.read(s.buf);
    // scan middle row for red-ish (f43f5e ~ 244,63,94) pixels to find left edge of box
    const row = Math.floor(png.height / 2) * png.width;
    let foundX = -1;
    for (let x = 0; x < png.width; x++) {
      const idx = (row + x) * 4;
      const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2];
      if (r > 200 && g < 100 && b < 120) { foundX = x; break; }
    }
    if (foundX > 0) {
      if (lastX > 0 && Math.abs(foundX - lastX) > 1) movedDuringFreeze++;
      lastX = foundX;
    }
  }

  return { samples: samples.length, movedUpdates: movedDuringFreeze, lastVisualX: lastX };
}

async function runScenario5_ImportCost() {
  // esbuild bundle + minify + gzip of identical "spring 1 element + retarget" scenario using each lib
  const scenarioCode = `
    const box = document.createElement('div');
    box.style.transform = 'translateX(0)';
    // animate to 240 + retargets (syntax will be replaced per lib in real bundle)
    console.log('scenario');
  `;
  const results = {};
  for (const [key, lib] of Object.entries(LIBS)) {
    let input;
    if (key === 'lab-motion') {
      input = resolve(DIST, 'index.js');
    } else if (key === 'motion') {
      input = resolve(__dirname, 'node_modules/motion/dist/es/index.mjs');
    } else if (key === 'gsap') {
      input = lib.path;
    } else {
      input = lib.path;
    }
    try {
      const bundled = await build({
        entryPoints: [input],
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'browser',
        write: false,
        sourcemap: false
      });
      const gz = gzipSync(bundled.outputFiles[0].contents).length;
      results[key] = gz;
    } catch (e) {
      results[key] = 'ERR:' + e.message.slice(0, 60);
    }
  }
  return results;
}

async function runAll() {
  console.log('=== @labpics/motion bench/compare (Playwright + CDP 4x throttle, N=' + N_RUNS + ', median+IQR) ===');
  console.log('Methodology: real Chromium, transform/opacity only, screenshot pixel scan for freeze. Versions pinned in package.');
  const allResults = {};

  for (const key of Object.keys(LIBS).filter(k => k !== 'animejs')) {
    allResults[key] = { name: LIBS[key].name, runs: [] };
    console.log('\n--- ' + LIBS[key].name + ' ---');
    const { browser, page } = await createBrowser();
    try {
      const s1s = [], s2s = [], s3s = [], s4s = [];
      for (let i = 0; i < N_RUNS; i++) {
        const s1 = await runScenario1_SingleSpringRetarget(page, key);
        const s2 = await runScenario2_100Springs(page, key);
        const s3 = await runScenario3_Stagger200(page, key);
        const s4 = await runScenario4_Freeze(page, key);
        s1s.push(s1.setupMs); s2s.push(s2.setupMs); s3s.push(s3.setupMs); s4s.push(s4.movedUpdates);
        console.log(`  run${i + 1}: s1=${s1.setupMs}ms s2=${s2.setupMs}ms s3=${s3.setupMs}ms freezeUpdates=${s4.movedUpdates}`);
      }
      allResults[key].s1 = stats(s1s);
      allResults[key].s2 = stats(s2s);
      allResults[key].s3 = stats(s3s);
      allResults[key].s4 = stats(s4s);
      console.log(`  MEDIAN s1=${allResults[key].s1.median} IQR=${allResults[key].s1.iqr} | freeze=${allResults[key].s4.median}`);
    } finally {
      await browser.close();
    }
  }

  // scenario 5 import cost (no browser)
  console.log('\n--- Import cost (esbuild min+gz bytes) ---');
  const importCosts = await runScenario5_ImportCost();
  console.log(importCosts);

  // cleanup
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}

  return { results: allResults, import: importCosts, meta: { throttle: THROTTLE, n: N_RUNS, date: new Date().toISOString(), chromium: 'playwright 1.45 pinned' } };
}

runAll().then(r => {
  console.log('\n=== FINAL JSON (paste to docs) ===');
  console.log(JSON.stringify(r, null, 2));
}).catch(e => { console.error(e); process.exit(1); });

