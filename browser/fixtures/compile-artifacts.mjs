/**
 * compile-artifacts.mjs — playwright globalSetup для 17-compiler-nano.spec.
 *
 * Собирает ОДИН fixture `animate(el, { opacity: 0.5 })` реальным Vite дважды —
 * с плагином motionCompiler() (compiled) и без (uncompiled) — в самодостаточные
 * ESM-бандлы `browser/.artifacts/{compiled,uncompiled}.js`. Спека грузит оба по
 * http и сверяет opacity-траекторию в реальном движке: доказывает, что
 * precomputed-артефакт compiled-пути рендерится идентично рантаймовому nano на
 * chromium/firefox/webkit. Alias публичных субпутей → dist (байты потребителя).
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
};
const FIXTURE = `import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }`;

// Полный common-motion срез #220/#221: multi-prop кадр + spring/delay/stagger.
const FIXTURE_COMMON = `import { animate } from '@labpics/motion/nano';
export function play(els) {
  return animate(els, { translate: '120px 0', scale: 1.04, rotate: 8, opacity: 0.5 }, {
    spring: { mass: 1, stiffness: 170, damping: 26 },
    delay: 40,
    stagger: 20,
  });
}`;

async function bundle(motionCompiler, withPlugin, fixture = FIXTURE) {
  const entry = resolve(TMP, 'entry.js');
  writeFileSync(entry, fixture);
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

export default async function globalSetup() {
  if (!existsSync(DIST)) {
    throw new Error('compile-artifacts: dist отсутствует — сначала pnpm build');
  }
  // Плагин из собранного dist — импорт после проверки существования dist.
  const { motionCompiler } = await import('../../dist/compiler/vite/index.js');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  try {
    const compiled = await bundle(motionCompiler, true);
    const uncompiled = await bundle(motionCompiler, false);
    const compiledCommon = await bundle(motionCompiler, true, FIXTURE_COMMON);
    const uncompiledCommon = await bundle(motionCompiler, false, FIXTURE_COMMON);
    // Санити globalSetup: бандлы самодостаточны (браузер грузит их как есть) и
    // несут ожидаемую форму — иначе спека упала бы позже с мутным import-сбоем.
    for (const code of [compiled, uncompiled, compiledCommon, uncompiledCommon]) {
      if (/^\s*import\s/m.test(code)) {
        throw new Error('compile-artifacts: бандл несёт bare-import — не самодостаточен');
      }
    }
    if (!/linear\(/.test(compiled) || !/linear\(/.test(compiledCommon)) {
      throw new Error('compile-artifacts: compiled не содержит precomputed linear()-артефакт');
    }
    if (!/8deg/.test(compiledCommon)) {
      throw new Error('compile-artifacts: compiled-common не несёт канонический rotate-артефакт');
    }
    writeFileSync(resolve(OUT, 'compiled.js'), compiled);
    writeFileSync(resolve(OUT, 'uncompiled.js'), uncompiled);
    writeFileSync(resolve(OUT, 'compiled-common.js'), compiledCommon);
    writeFileSync(resolve(OUT, 'uncompiled-common.js'), uncompiledCommon);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}
