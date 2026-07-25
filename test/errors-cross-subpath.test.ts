/**
 * errors-cross-subpath.test.ts — ловля ошибок ЧЕРЕЗ ГРАНИЦЫ СУБПУТЕЙ.
 *
 * ЗАЧЕМ. Аудит 2026-07-25 нашёл дефект, невидимый для всей исходной сьюты:
 * в ИСХОДНИКАХ `MotionParamError` — один модуль, поэтому `instanceof` в тестах
 * всегда истинен. В СОБРАННОМ пакете code-splitting выключен, у каждого субпутя
 * своя копия класса, и документированный на восьми reference-страницах паттерн
 *
 *   import { animate } from '@labpics/motion/animate';
 *   import { MotionParamError } from '@labpics/motion';
 *   try { animate(...) } catch (e) { if (e instanceof MotionParamError) … }
 *
 * возвращал false ВСЕГДА. Минификация вдобавок стирает `constructor.name` в 'o'.
 *
 * Поэтому этот файл ОБЯЗАН читать dist, а не src: проверять исходники здесь —
 * значит проверять не то, что получает потребитель. Mutation proof: вернуть в
 * isMotionParamError сравнение по ссылке (`value instanceof MotionParamError`)
 * → все кросс-субпутевые кейсы RED.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { distReady } from './support/dist-required.js';

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

/** Ошибка, которую бросил субпуть, — вместе с именем субпутя для сообщений. */
async function errorFrom(subpath: string, run: (mod: never) => unknown): Promise<unknown> {
  const mod = await import(`${distRoot}/${subpath}`) as never;
  try {
    run(mod);
  } catch (error) {
    return error;
  }
  throw new Error(`субпуть ${subpath} не бросил ошибку — кейс выродился`);
}

describe.runIf(distReady())('ошибки пакета через границы субпутей', () => {
  it('isMotionParamError из корня признаёт ошибки чужих субпутей', async () => {
    const { isMotionParamError } = await import(`${distRoot}/index.js`) as {
      isMotionParamError(value: unknown): boolean;
    };

    const cases: [subpath: string, run: (m: never) => unknown, code: string][] = [
      ['animate/index.js', (m: never) => (m as { animate: Function }).animate(null, { opacity: 1 }), 'LM146'],
      ['compositor/index.js', (m: never) => (m as { compileSpringLinear: Function })
        .compileSpringLinear({ mass: 1, stiffness: 0, damping: 26 }), 'LM089'],
      ['utils/index.js', (m: never) => (m as { clamp: Function }).clamp(1, Number.NaN, 2), 'LM111'],
    ];

    for (const [subpath, run, code] of cases) {
      const error = await errorFrom(subpath, run);
      expect(isMotionParamError(error), `${subpath}: гвард не признал свою ошибку`).toBe(true);
      expect((error as { code?: string }).code, `${subpath}: код`).toBe(code);
    }
  });

  it('гвард доступен из ./animate — ловить можно, не импортируя корневой entry', async () => {
    const { isMotionParamError } = await import(`${distRoot}/animate/index.js`) as {
      isMotionParamError(value: unknown): boolean;
    };
    const error = await errorFrom(
      'compositor/index.js',
      (m: never) => (m as { compileSpringLinear: Function })
        .compileSpringLinear({ mass: 1, stiffness: 0, damping: 26 }),
    );
    expect(isMotionParamError(error)).toBe(true);
  });

  it('чужие значения гвард отвергает', async () => {
    const { isMotionParamError } = await import(`${distRoot}/index.js`) as {
      isMotionParamError(value: unknown): boolean;
    };
    for (const alien of [new TypeError('x'), new Error('LM146'), null, undefined, 'LM146', 42,
      { name: 'OtherError' }, {}]) {
      expect(isMotionParamError(alien), `отвергается: ${String(alien)}`).toBe(false);
    }
  });

  it('минификация стирает constructor.name — на него полагаться нельзя (характеризация)', async () => {
    const error = await errorFrom(
      'animate/index.js',
      (m: never) => (m as { animate: Function }).animate(null, { opacity: 1 }),
    ) as Error;
    // Это НЕ пожелание, а зафиксированный факт сборки: имя конструктора не
    // переживает минификацию, а собственное поле name — переживает.
    expect(error.name).toBe('MotionParamError');
    expect(error.constructor.name).not.toBe('MotionParamError');
    expect(error).toBeInstanceOf(Error);
  });

  it('характеризация: прямой instanceof через границу субпутей НЕ работает', async () => {
    const { MotionParamError } = await import(`${distRoot}/index.js`) as {
      MotionParamError: new (code: string) => Error;
    };
    const foreign = await errorFrom(
      'animate/index.js',
      (m: never) => (m as { animate: Function }).animate(null, { opacity: 1 }),
    );
    // Именно поэтому документация учит гварду, а не instanceof. Если этот
    // ассерт когда-нибудь упадёт — значит появился code-splitting либо бренд в
    // самом классе, и документацию надо вернуть к instanceof.
    expect(foreign instanceof MotionParamError).toBe(false);
    // А своя копия класса в своём же субпути, разумеется, работает.
    const own = await errorFrom(
      'index.js',
      (m: never) => (m as { spring: Function }).spring({ mass: 0, stiffness: 1, damping: 1 }),
    );
    expect(own instanceof MotionParamError).toBe(true);
  });
});
