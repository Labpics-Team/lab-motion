/**
 * compile-artifacts.mjs — playwright globalSetup для 17-compiler-nano.spec и
 * 19-surface-compiler.spec.
 *
 * Собирает ДВА fixture реальным Vite, каждый дважды — с плагином
 * motionCompiler() (compiled) и без (uncompiled) — в самодостаточные
 * ESM-бандлы `browser/.artifacts/`:
 *   • nano: `animate(el, { opacity: 0.5 })` — compiled/uncompiled;
 *   • surface: `animate(el, { width: [240, 360] }, { layout: 'project' })`
 *     и list-вариант — surface-compiled/surface-uncompiled.
 * Спеки грузят бандлы по http и сверяют наблюдаемое в РЕАЛЬНОМ движке
 * (chromium/firefox/webkit): precomputed-артефакт compiled-пути рендерится
 * идентично рантаймовому. Alias публичных субпутей → dist (байты потребителя);
 * surface-executor живёт под приватным путём `@labpics/motion/compiler/surface`
 * (горячий фикс наблюдаемой эквивалентности перевёл его из публичного
 * `./surface` в приватный compiler-неймспейс).
 */

import { build } from 'vite';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = resolve(ROOT, 'dist');
const OUT = resolve(ROOT, 'browser', '.artifacts');
const TMP = resolve(OUT, '.tmp');

const ALIAS = {
  '@labpics/motion/nano': resolve(DIST, 'nano/index.js'),
  '@labpics/motion/compiler/runtime': resolve(DIST, 'compiler/runtime/index.js'),
  '@labpics/motion/animate': resolve(DIST, 'animate/index.js'),
  '@labpics/motion/compiler/surface': resolve(DIST, 'compiler/surface/index.js'),
};
const NANO_FIXTURE = `import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }`;
// Позитивная форма после hotfix наблюдаемой эквивалентности (PR-1 Future
// Layout): lowering сертифицируется ТОЛЬКО для голого expression statement —
// результат не присваивается, не return'ится, не await'ится: неполные
// compiled-контролы тогда не наблюдаемы. Спека 19 потребляет observable
// финал (ширина, стили движка, отсутствие residual-стилей) через DOM, без
// чтения возвращаемого значения.
const SURFACE_FIXTURE = `import { animate } from '@labpics/motion/animate';
export function play(el) { animate(el, { width: [240, 360] }, { layout: 'project' }); }
export function playList(list) { animate(list, { width: [240, 360] }, { layout: 'project' }); }`;
// Return-форма обязана остаться не-lowered — positive control границы
// наблюдаемой эквивалентности: вызов, чей результат уходит наружу, понижается
// только когда lowered-контрол полностью эквивалентен runtime.
const RETURN_FIXTURE = `import { animate } from '@labpics/motion/animate';
export function play(el) { return animate(el, { width: [240, 360] }, { layout: 'project' }); }`;

async function bundle(motionCompiler, source, withPlugin) {
  const entry = resolve(TMP, 'entry.js');
  writeFileSync(entry, source);
  const result = await build({
    root: ROOT,
    logLevel: 'silent',
    configFile: false,
    resolve: { alias: ALIAS },
    plugins: withPlugin ? [motionCompiler()] : [],
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: ['es'], fileName: 'x' },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const chunk = output.find((o) => o.type === 'chunk' && o.isEntry) ?? output[0];
  return chunk.code;
}

function assertSelfContained(code, label) {
  if (/^\s*import\s/m.test(code)) {
    throw new Error(`compile-artifacts: ${label} несёт bare-import — не самодостаточен`);
  }
}

export default async function globalSetup() {
  if (!existsSync(DIST)) {
    throw new Error('compile-artifacts: dist отсутствует — сначала pnpm build');
  }
  // Плагин из собранного dist — импорт после проверки существования dist.
  const { motionCompiler } = await import('../../dist/compiler/vite/index.js');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  try {
    const compiled = await bundle(motionCompiler, NANO_FIXTURE, true);
    const uncompiled = await bundle(motionCompiler, NANO_FIXTURE, false);
    const surfaceCompiled = await bundle(motionCompiler, SURFACE_FIXTURE, true);
    const surfaceUncompiled = await bundle(motionCompiler, SURFACE_FIXTURE, false);
    // Санити globalSetup: бандлы самодостаточны (браузер грузит их как есть) и
    // несут ожидаемую форму — иначе спека упала бы позже с мутным import-сбоем.
    assertSelfContained(compiled, 'nano compiled');
    assertSelfContained(uncompiled, 'nano uncompiled');
    assertSelfContained(surfaceCompiled, 'surface compiled');
    assertSelfContained(surfaceUncompiled, 'surface uncompiled');
    if (!/linear\(/.test(compiled)) {
      throw new Error('compile-artifacts: compiled не содержит precomputed linear()-артефакт');
    }
    // Surface lowering обязан был сработать: литеральный артефакт {w0:240,w1:360…}
    // присутствует, а исходный runtime-вызов animate(...) с layout:'project'
    // заменён executor-вызовом (иначе спека молча тестирует runtime path).
    if (!/\bw0:\s*240,\s*w1:\s*360/.test(surfaceCompiled)) {
      throw new Error('compile-artifacts: surface compiled не содержит литеральный артефакт — lowering не сработал');
    }
    if (!/layout:\s*"project"|layout:\s*'project'/.test(surfaceUncompiled)) {
      throw new Error('compile-artifacts: surface uncompiled потерял layout-опцию');
    }
    // Positive control границы: return-форма НЕ понижается (горячий фикс
    // наблюдаемой эквивалентности). Если плагин ослабит правило, спека 19
    // начнёт молча мерить runtime-ветку и даст ложный PASS на compiled-контракт.
    const surfaceReturn = await bundle(motionCompiler, RETURN_FIXTURE, true);
    assertSelfContained(surfaceReturn, 'surface return-form');
    if (!/layout:\s*"project"|layout:\s*'project'/.test(surfaceReturn) || /w0:\s*240,\s*w1:\s*360/.test(surfaceReturn)) {
      throw new Error('compile-artifacts: return-форма ошибочно понижена — нарушена наблюдаемая эквивалентность');
    }
    writeFileSync(resolve(OUT, 'compiled.js'), compiled);
    writeFileSync(resolve(OUT, 'uncompiled.js'), uncompiled);
    writeFileSync(resolve(OUT, 'surface-compiled.js'), surfaceCompiled);
    writeFileSync(resolve(OUT, 'surface-uncompiled.js'), surfaceUncompiled);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}
