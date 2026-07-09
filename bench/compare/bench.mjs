/**
 * bench/compare/bench.mjs — сравнительный бенчмарк @labpics/motion vs Motion / GSAP / anime.js.
 *
 * ЧЕСТНОСТЬ (контракт файла):
 * - Все четыре библиотеки — РЕАЛЬНЫЕ пакеты (vendor'ы из npm, наш — собранный dist),
 *   собранные esbuild'ом в IIFE и исполняемые в реальном Chromium (Playwright).
 * - Ни одного захардкоженного «vendor»-числа, ни одного множителя поверх измерений,
 *   ни одного sim-фоллбэка: нет браузера или dist — процесс падает с ошибкой.
 * - Freeze-тест меряется ВИЗУАЛЬНО: скриншоты через сырой CDP Page.captureScreenshot
 *   (компоситор жив при заблокированном main-thread), позиция — пиксель-скан pngjs.
 * - Смоук-гейт: если адаптер библиотеки не двигает элемент — прогон прерывается,
 *   а не публикует нули за конкурента.
 *
 * Запуск: cd bench/compare && pnpm i && node bench.mjs   (перед этим: pnpm build в корне)
 * Переменные: BENCH_RUNS (дефолт 5), BENCH_FREEZE_RUNS (дефолт 3).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import esbuild from 'esbuild';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RUNS = Math.max(1, Number(process.env.BENCH_RUNS ?? 5));
const FREEZE_RUNS = Math.max(1, Number(process.env.BENCH_FREEZE_RUNS ?? 3));

const LIBS = [
  { id: 'lab', entry: 'entries/lab.entry.mjs', pkg: null },
  { id: 'motion', entry: 'entries/motion.entry.mjs', pkg: 'motion' },
  { id: 'gsap', entry: 'entries/gsap.entry.mjs', pkg: 'gsap' },
  { id: 'anime', entry: 'entries/anime.entry.mjs', pkg: 'animejs' },
  // S4-only ряды вне tween-матрицы (S1–S3/S5 у них «н/д» намеренно):
  // контроль инструмента и компоситорный (spring→WAAPI) путь нашего фасада.
  { id: 'waapi-ctl', entry: 'entries/waapi-control.entry.mjs', pkg: null, s4Only: true, ver: 'платформа Chromium (без библиотеки)' },
  { id: 'lab-spring', entry: 'entries/lab-spring.entry.mjs', pkg: null, s4Only: true },
];

// ─── утилиты ─────────────────────────────────────────────────────────────────

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const fmt = (n, d = 2) => (n === null || Number.isNaN(n) ? 'н/д' : n.toFixed(d));

function fail(msg) {
  console.error(`\nБЕНЧ ПРЕРВАН: ${msg}`);
  console.error('Симуляций и подстановок этот бенчмарк не делает намеренно.');
  process.exit(1);
}

function libVersion(lib, rootPkg) {
  if (lib.ver) return lib.ver;
  if (!lib.pkg) return `${rootPkg.name}@${rootPkg.version} (локальный dist)`;
  const p = JSON.parse(readFileSync(path.join(__dirname, 'node_modules', lib.pkg, 'package.json'), 'utf8'));
  return `${p.name}@${p.version}`;
}

// ─── сборка адаптеров ────────────────────────────────────────────────────────

function buildAdapter(lib) {
  const outfile = path.join(__dirname, 'results', `.${lib.id}.iife.js`);
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, lib.entry)],
    bundle: true,
    format: 'iife',
    globalName: '__adapterModule',
    platform: 'browser',
    outfile,
    logLevel: 'silent',
  });
  return outfile;
}

/** import-cost: тот же entry, но ESM + minify + gzip-9 — реальные байты потребителя. */
function measureSize(lib) {
  const res = esbuild.buildSync({
    entryPoints: [path.join(__dirname, lib.entry)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    write: false,
    logLevel: 'silent',
  });
  const raw = res.outputFiles[0].contents;
  return { raw: raw.byteLength, gz: gzipSync(raw, { level: 9 }).byteLength };
}

// ─── страница ────────────────────────────────────────────────────────────────

const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; }
  .box { position: absolute; left: 0; top: 0; width: 10px; height: 10px; background: #0000ff; }
  #probe { position: absolute; left: 0; top: 20px; width: 30px; height: 30px; background: #ff0000; }
</style></head><body></body></html>`;

async function newPage(browser, adapterPath) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 200 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.setContent(PAGE_HTML);
  await page.addScriptTag({ path: adapterPath });
  const ok = await page.evaluate(() => typeof window.__adapterModule?.start === 'function');
  if (!ok) fail(`адаптер не загрузился: ${adapterPath}`);
  return { context, page };
}

/** Смоук: адаптер реально двигает элемент, иначе весь прогон недействителен. */
async function smokeCheck(page, libId) {
  const moved = await page.evaluate(async () => {
    const el = document.createElement('div');
    el.className = 'box';
    document.body.appendChild(el);
    window.__adapterModule.start([el], 200, 400);
    await new Promise((r) => setTimeout(r, 250));
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    el.remove();
    return m.e;
  });
  if (!(moved > 10)) fail(`смоук ${libId}: элемент не сдвинулся (x=${moved}) — адаптер неисправен, числа были бы враньём`);
}

// ─── сценарии S1–S3: scripting-стоимость старта ──────────────────────────────

async function runStartCosts(page) {
  return page.evaluate(() => {
    const A = window.__adapterModule;
    const mk = (n) => {
      const list = [];
      for (let i = 0; i < n; i++) {
        const d = document.createElement('div');
        d.className = 'box';
        document.body.appendChild(d);
        list.push(d);
      }
      return list;
    };
    const drop = (els, c) => { try { c.cancel(); } catch { /* noop */ } els.forEach((e) => e.remove()); };
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

    // S1: 40 стартов в одном таймированном блоке — квантование performance.now()
    // (~100µs) делает поштучный замер нулевым; делим суммарное время.
    const els1 = mk(40);
    const ctrls = [];
    const t1s = performance.now();
    for (const el of els1) ctrls.push(A.start([el], 300, 1200));
    const s1 = (performance.now() - t1s) / 40;
    ctrls.forEach((c) => { try { c.cancel(); } catch { /* noop */ } });
    els1.forEach((e) => e.remove());

    // S2: один вызов на 100 элементов.
    const els2 = mk(100);
    const t2 = performance.now();
    const c2 = A.start(els2, 300, 1200);
    const s2 = performance.now() - t2;
    drop(els2, c2);

    // S3: stagger-каскад на 200 элементов, gap 5ms.
    const els3 = mk(200);
    const t3 = performance.now();
    const c3 = A.startStagger(els3, 300, 1200, 5);
    const s3 = performance.now() - t3;
    drop(els3, c3);

    void med;
    return { s1, s2, s3 };
  });
}

// ─── сценарий S4: freeze-continuity (визуальный) ─────────────────────────────

function redLeftEdge(pngBuf) {
  // Полный скан: кадры скринкаста — целый вьюпорт (возможен и letterbox),
  // привязываться к конкретной строке нельзя. Ищем левейший красный пиксель.
  const img = PNG.sync.read(pngBuf);
  let left = null;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (left !== null && x >= left) break;
      const i = (img.width * y + x) << 2;
      if (img.data[i] > 180 && img.data[i + 1] < 120 && img.data[i + 2] < 120) {
        left = x;
        break;
      }
    }
  }
  return left;
}

async function runFreeze(browser, adapterPath, libId) {
  const { context, page } = await newPage(browser, adapterPath);
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => {
    const p = document.createElement('div');
    p.id = 'probe';
    document.body.appendChild(p);
  });

  const PX = 600, DUR = 2400, BLOCK_AT = 300, BLOCK_MS = 900;

  // Кадры забираем скринкастом: компоситор пушит их сам, main-thread страницы
  // не участвует. Одиночный Page.captureScreenshot при мёртвом main стопорится
  // и возвращает кадр уже ПОСЛЕ разблокировки — это давало бы wall-clock-прыжку
  // RAF-библиотек фальшивые 100% (проверено первым прогоном этого файла).
  const frames = [];
  cdp.on('Page.screencastFrame', (ev) => {
    frames.push({ ts: ev.metadata.timestamp, data: ev.data });
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'png', everyNthFrame: 1, maxWidth: 800, maxHeight: 200,
  });

  // Старт анимации + отложенная блокировка main-thread изнутри страницы.
  await page.evaluate(({ PX, DUR, BLOCK_AT, BLOCK_MS }) => {
    const el = document.getElementById('probe');
    window.__c = window.__adapterModule.start([el], PX, DUR);
    setTimeout(() => {
      const end = performance.now() + BLOCK_MS;
      while (performance.now() < end) { /* busy: реальный фриз main-thread */ }
    }, BLOCK_AT);
  }, { PX, DUR, BLOCK_AT, BLOCK_MS });
  const wall0 = Date.now() / 1000; // ≈ старт анимации (±RTT evaluate, ~единицы мс)

  // Ждём: анимация + блок + запас на lagSmoothing-подобное продление (GSAP
  // после лага честно доигрывает сдвинутый таймлайн, а не прыгает — это
  // валидное поведение, ему нужно время).
  await new Promise((r) => setTimeout(r, DUR + BLOCK_MS + 700));
  await cdp.send('Page.stopScreencast').catch(() => {});
  const finalX = await page.evaluate(() => {
    const el = document.getElementById('probe');
    return new DOMMatrixReadOnly(getComputedStyle(el).transform).e;
  });
  await context.close();

  // Декод кадров и hold-семантика дисплея: в грид-момент видна ПОСЛЕДНЯЯ
  // закоммиченная позиция. Окно с полями 80мс от краёв блока.
  const decoded = frames
    .map((f) => ({ ts: f.ts, x: redLeftEdge(Buffer.from(f.data, 'base64')) }))
    .filter((f) => f.x !== null)
    .sort((a, b) => a.ts - b.ts);
  const w0 = wall0 + (BLOCK_AT + 80) / 1000;
  const w1 = wall0 + (BLOCK_AT + BLOCK_MS - 80) / 1000;
  const framesInWindow = decoded.filter((f) => f.ts >= w0 && f.ts <= w1).length;

  const ratios = [];
  for (let g = w0; g <= w1; g += 0.1) {
    let held = null;
    for (const f of decoded) { if (f.ts <= g) held = f; else break; }
    if (!held) continue;
    const tAnim = (g - wall0) * 1000;
    const expected = PX * Math.min(tAnim / DUR, 1);
    if (expected > 0) ratios.push(Math.min(held.x / expected, 1));
  }

  if (decoded.length === 0 || ratios.length < 5) {
    console.warn(`  ${libId}: скринкаст не дал пригодных кадров (raw=${frames.length}, с красным=${decoded.length}, ratios=${ratios.length}) — честный ответ: н/д`);
    return { continuity: null, framesInWindow, finalX };
  }
  if (finalX < PX * 0.9) {
    console.warn(`  ${libId}: финал ${fmt(finalX, 0)}px < ${PX * 0.9} спустя DUR+BLOCK+700мс — адаптер невалиден, н/д`);
    return { continuity: null, framesInWindow, finalX };
  }
  return {
    continuity: (ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100,
    framesInWindow,
    finalX,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'animate', 'index.js'))) {
    fail('нет dist/animate/index.js — сначала `pnpm build` в корне репозитория');
  }
  mkdirSync(path.join(__dirname, 'results'), { recursive: true });

  const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let gitRev = 'н/д';
  try { gitRev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { /* вне git */ }

  // Headed обязателен: headless-Chromium производит кадры только по main-thread
  // коммитам (BeginFrame по требованию) — во время фриза кадров нет ни у кого,
  // и S4 выродился бы в hold-артефакт ~45% у всех (проверено v3-прогоном).
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    });
  } catch (e) {
    fail(`Chromium не запустился (${e.message.split('\n')[0]}). Установите: npx playwright install chromium`);
  }
  const browserVersion = browser.version();

  const env = [
    `Дата: ${new Date().toISOString()}`,
    `Ревизия: ${gitRev}`,
    `Машина: ${os.cpus()[0]?.model?.trim() ?? 'н/д'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`,
    `ОС: ${os.type()} ${os.release()}; Node ${process.version}; Chromium ${browserVersion}`,
    `Прогонов: S1–S3 × ${RUNS}, freeze × ${FREEZE_RUNS}; агрегация — медиана`,
    `Библиотеки: ${LIBS.map((l) => libVersion(l, rootPkg)).join(', ')}`,
  ];
  console.log('=== Честный сравнительный бенчмарк ===');
  env.forEach((l) => console.log(l));

  const results = {};
  for (const lib of LIBS) {
    console.log(`\n— ${lib.id}: сборка адаптера…`);
    const adapterPath = buildAdapter(lib);
    const size = lib.s4Only ? null : measureSize(lib);

    { // смоук на свежей странице
      const { context, page } = await newPage(browser, adapterPath);
      await smokeCheck(page, lib.id);
      await context.close();
    }

    const s1 = [], s2 = [], s3 = [];
    if (!lib.s4Only) {
      for (let r = 0; r < RUNS; r++) {
        const { context, page } = await newPage(browser, adapterPath);
        const res = await runStartCosts(page);
        s1.push(res.s1); s2.push(res.s2); s3.push(res.s3);
        await context.close();
      }
    }

    const freezes = [];
    const framesW = [];
    let finalX = null;
    for (let r = 0; r < FREEZE_RUNS; r++) {
      const f = await runFreeze(browser, adapterPath, lib.id);
      freezes.push(f.continuity);
      framesW.push(f.framesInWindow);
      finalX = f.finalX;
    }
    const valid = freezes.filter((f) => f !== null);

    results[lib.id] = {
      version: libVersion(lib, rootPkg),
      s1: s1.length ? median(s1) : null,
      s2: s2.length ? median(s2) : null,
      s3: s3.length ? median(s3) : null,
      freeze: valid.length ? median(valid) : null,
      framesInWindow: median(framesW),
      finalX,
      size,
    };
    console.log(`  s1=${fmt(results[lib.id].s1)}ms s2=${fmt(results[lib.id].s2)}ms s3=${fmt(results[lib.id].s3)}ms freeze=${fmt(results[lib.id].freeze, 0)}% gz=${size ? `${size.gz}B` : 'н/д'}`);
  }
  await browser.close();

  // ─── отчёт ─────────────────────────────────────────────────────────────────
  const ids = LIBS.map((l) => l.id);
  const row = (label, f) => `| ${label} | ${ids.map((id) => f(results[id])).join(' | ')} |`;
  const md = [
    '# Сравнительный бенчмарк — реальный прогон',
    '',
    ...env.map((l) => `- ${l}`),
    '',
    'Все столбцы измерены этим скриптом в одном Chromium-прогоне; сценарий — линейный tween',
    'x→300px/1200ms (общий знаменатель всех библиотек; пружины у всех разные и несравнимы напрямую).',
    'Столбцы `waapi-ctl` и `lab-spring` — S4-only, вне tween-матрицы (их S1–S3/S5 — «н/д» намеренно).',
    '',
    `| Метрика | ${ids.join(' | ')} |`,
    `|---|${ids.map(() => '---').join('|')}|`,
    row('Версия', (r) => r.version),
    row('S1: старт, 1 эл (среднее по 40 в блоке, мс)', (r) => fmt(r.s1, 3)),
    row('S2: старт, 100 эл одним вызовом (мс)', (r) => fmt(r.s2)),
    row('S3: stagger 200 эл, gap 5мс (мс)', (r) => fmt(r.s3)),
    row('S4: continuity при фризе main 900мс (%)', (r) => fmt(r.freeze, 0)),
    row('S4: кадров компоситора в окне фриза', (r) => fmt(r.framesInWindow, 0)),
    row('S4: финальная позиция x (санити, px)', (r) => fmt(r.finalX, 0)),
    row('S5: import-cost адаптера, min+gz (B)', (r) => (r.size ? String(r.size.gz) : 'н/д')),
    '',
    '## Методология S4 (freeze)',
    '',
    'Анимация 600px/2400ms; на t=300ms страница блокирует свой main-thread busy-циклом на 900ms.',
    'Кадры собираются CDP `Page.startScreencast` — их пушит компоситор, main-thread страницы не',
    'участвует; позиция = пиксель-скан левого края красного квадрата (pngjs). continuity — среднее',
    'по 100мс-гриду окна блокировки (поля 80мс) отношения «удержанная позиция последнего кадра /',
    'ожидаемая по wall-clock», cap 1.0. Одиночный `Page.captureScreenshot` для этого непригоден:',
    'при мёртвом main он стопорится и возвращает кадр после разблокировки, что дарит RAF-библиотекам',
    'фальшивые 100% за счёт wall-clock-прыжка (наблюдалось на первом прогоне этого скрипта).',
    '«Кадров в окне» ≈ 0 означает: библиотека не производила видимых кадров во время фриза.',
    '',
    '## Оговорки честности',
    '',
    '- S1–S3 — синхронная стоимость вызова. GSAP ленив (`lazy: true`): часть работы уезжает в',
    '  первый тик и в S1–S3 не попадает — его числа занижены относительно остальных.',
    '- GSAP после лага не прыгает (lag smoothing), а доигрывает сдвинутый таймлайн — поэтому его',
    '  финальная позиция снимается с запасом +700мс; это поведение, а не дефект.',
    '- Пружины четырёх библиотек математически разные и напрямую несравнимы — потому общий',
    '  знаменатель здесь линейный tween.',
    '- Часы Node и страницы сведены с точностью RTT `evaluate` (±единицы мс) — на 900мс-окне шум.',
    '- `waapi-ctl` — голый `Element.animate` (платформа, не библиотека): контроль того, что скринкаст',
    '  вообще видит компоситорные кадры при фризе main. Если у него кадры в окне есть, а у библиотеки — 0,',
    '  ноль настоящий (библиотека рисует по main-thread RAF), а не артефакт инструмента.',
    '- `lab-spring` — spring-режим @labpics/motion: единственный путь фасада через компоситор (WaapiUnit;',
    '  tween-режим уходит в MainUnit по main-thread у ВСЕХ четырёх участников, включая наш). Его',
    '  continuity считается против линейного эталона и потому приближение; ключевая метрика —',
    '  «кадров компоситора в окне фриза».',
    '',
    '_Файл сгенерирован bench/compare/bench.mjs; правки руками = подлог._',
    '',
  ].join('\n');

  const outPath = path.join(__dirname, 'results', `${new Date().toISOString().slice(0, 10)}-${gitRev}.md`);
  writeFileSync(outPath, md);
  console.log(`\n${md}`);
  console.log(`Отчёт: ${outPath}`);
}

main().catch((e) => fail(e.stack ?? String(e)));
