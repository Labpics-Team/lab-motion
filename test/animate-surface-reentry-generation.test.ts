/**
 * test/animate-surface-reentry-generation.test.ts — #196: сохранение видимой
 * transform-поверхности при post-write reentry.
 *
 * Класс: hostile-host (канон animate-lifecycle-atomicity). Сценарий issue:
 * hostile `style.setProperty` СНАЧАЛА применяет кадр текущего owner (значение
 * становится видимым), а затем синхронно запускает новый `animate()` для
 * другой transform-компоненты. Successor обязан продолжить с только что
 * применённого поколения поверхности, а не с прошлого rendered-снапшота.
 *
 * Инвариант (#196): один CSS setter, owner registry и residual snapshot
 * публикуют ОДНО поколение всей transform-поверхности — значение И скорость;
 * видимое post-write значение нельзя потерять или заменить stale
 * repair-записью, а осевшая (settle) поверхность несёт скорость покоя.
 * Старый owner после потери lease молча уступает: ни финализации, ни
 * repair-записи, ни подмены исходной host-ошибки.
 */

import { describe, expect, it } from 'vitest';
import { readCompositorSpring } from '../src/compositor/index.js';
import { animate } from '../src/animate/index.js';
import {
  fakeEl,
  makeClock,
  readTranslateX,
  translateXSeries,
  type FakeElement,
  type StyleWrite,
} from './animate-facade-helpers.js';
import { impliedPickupVelocity } from './continuity-helpers.js';

const LINEAR = (t: number): number => t;
const SPRING = { mass: 1, stiffness: 170, damping: 26 };

/** Транзформ-записи журнала (без 'opacity' и прочих групп). */
function transformWrites(writes: readonly StyleWrite[]): StyleWrite[] {
  return writes.filter((w) => w.prop === 'transform');
}

/**
 * Hostile-обёртка fakeEl: setProperty ПРИМЕНЯЕТ запись (журнал + inline —
 * поведение реального CSSOM), затем зовёт trigger, который может реентрантно
 * вызвать animate() и/или бросить. Ровно сценарий #196: значение уже видимо
 * к моменту реентри.
 */
function hostileEl(): {
  f: FakeElement;
  setTrigger(cb: ((prop: string, value: string) => void) | undefined): void;
} {
  const f = fakeEl();
  const base = f.el.style.setProperty.bind(f.el.style);
  let onWrite: ((prop: string, value: string) => void) | undefined;
  f.el.style.setProperty = (prop: string, value: string): void => {
    base(prop, value);
    onWrite?.(prop, value);
  };
  return {
    f,
    setTrigger(cb) {
      onWrite = cb;
    },
  };
}

describe('#196: post-write reentry сохраняет видимую transform-поверхность', () => {
  it('apply-then-reenter: successor замораживает канал на применённом значении', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let triggerWrite: string | undefined;
    setTrigger((prop, value) => {
      // Первый неидентичный transform-кадр: значение уже видимо (применено).
      if (prop !== 'transform' || !value.includes('translateX(') || triggerWrite !== undefined) return;
      triggerWrite = value;
      animate(f.el, { rotate: [0, 90] }, {
        duration: 1000,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
    });

    animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(16); // разогрев (dt=0 → кадр x=0 → 'none')
    clock.step(484); // x=48.4 → запись применена → реентри rotate
    expect(triggerWrite).toBeDefined();
    const tokenX = /translateX\([^)]+\)/.exec(triggerWrite!)![0];

    clock.drain(16);

    const after = transformWrites(f.writes);
    const fromTrigger = after.slice(after.findIndex((w) => w.value === triggerWrite) + 1);
    // Успевший стать видимым translateX обязан присутствовать в КАЖДОЙ
    // последующей записи successor-а (замороженный residual-канал)…
    expect(fromTrigger.length).toBeGreaterThan(0);
    for (const w of fromTrigger) {
      expect(w.value).toContain(tokenX);
      expect(w.value).not.toBe('none');
    }
    // …и в финальной поверхности вместе с завершённым rotate.
    expect(f.writes.at(-1)!.value).toBe(`${tokenX} rotate(90deg)`);
  });

  it('registry после supersede хранит применённое поколение, не stale rendered', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let tokenX: string | undefined;
    setTrigger((prop, value) => {
      if (prop !== 'transform' || !value.includes('translateX(') || tokenX !== undefined) return;
      tokenX = /translateX\([^)]+\)/.exec(value)![0];
      animate(f.el, { rotate: [0, 90] }, {
        duration: 200,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
    });

    animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(16);
    clock.step(484);
    setTrigger(undefined);
    clock.drain(16); // rotate оседает; владельца больше нет

    // Третий прогон читает x уже ИЗ РЕЕСТРА (_writeBack старого owner):
    // stale-запись поколения до реентри потеряла бы applied-значение.
    const x = readTranslateX(tokenX!)!;
    animate(f.el, { y: [0, 20] }, {
      duration: 200,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.drain(16);
    expect(f.writes.at(-1)!.value).toBe(`translate(${x}px, 20px) rotate(90deg)`);
  });

  it('apply-then-reenter-then-throw (seek): successor жив, исходная host-ошибка сохранена', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let reentered = false;
    setTrigger((prop, value) => {
      if (prop !== 'transform' || !value.includes('translateX(50px)') || reentered) return;
      reentered = true;
      animate(f.el, { rotate: [0, 90] }, {
        duration: 100,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
      throw new Error('style failed');
    });

    const controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    // Синхронный seek: throw хоста обязан дойти до вызывающего без подмены
    // ошибкой cleanup, а созданный ДО throw successor — выжить.
    expect(() => controls.seek(500)).toThrow('style failed');
    expect(reentered).toBe(true);

    setTrigger(undefined);
    const writesBeforeStale = f.writes.length;
    // Старый owner потерял lease: его контролы больше не пишут style.
    controls.seek(900);
    controls.cancel();
    expect(f.writes.length).toBe(writesBeforeStale);

    clock.drain(16);
    expect(f.writes.at(-1)!.value).toBe('translateX(50px) rotate(90deg)');
  });

  it('reentry на settle-записи: seek не бросает, финал обоих поколений видим', async () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let reentered = false;
    setTrigger((prop, value) => {
      if (prop !== 'transform' || value !== 'translateX(100px)' || reentered) return;
      reentered = true;
      animate(f.el, { rotate: [0, 90] }, {
        duration: 100,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
    });

    const controls = animate(f.el, { x: [0, 100] }, {
      duration: 100,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    // Settle-запись реентрантно вытесняется. Старый owner уже терминализирован
    // successor-ом и обязан молча уступить, а не продолжить финализацию
    // с разобранным состоянием (baseline: TypeError из _writeBack).
    expect(() => controls.seek(100)).not.toThrow();
    expect(reentered).toBe(true);
    await expect(controls.finished).resolves.toBeUndefined();

    clock.drain(16);
    expect(f.writes.at(-1)!.value).toBe('translateX(100px) rotate(90deg)');
  });

  it('вложенные successors сохраняют все уже видимые transform-каналы', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let tokenX: string | undefined;
    let tokenRot: string | undefined;
    setTrigger((prop, value) => {
      if (prop !== 'transform') return;
      if (tokenX === undefined && value.includes('translateX(')) {
        tokenX = /translateX\([^)]+\)/.exec(value)![0];
        animate(f.el, { rotate: [0, 90] }, {
          duration: 1000,
          ease: LINEAR,
          requestFrame: clock.requestFrame,
        });
        return;
      }
      // Второй уровень: реентри на первом неидентичном rotate-кадре successor-а.
      if (tokenX !== undefined && tokenRot === undefined && value.includes('rotate(')) {
        tokenRot = /rotate\([^)]+\)/.exec(value)![0];
        animate(f.el, { y: [0, 20] }, {
          duration: 200,
          ease: LINEAR,
          requestFrame: clock.requestFrame,
        });
      }
    });

    animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(16);
    clock.step(484);
    expect(tokenX).toBeDefined();
    clock.drain(16);
    expect(tokenRot).toBeDefined();

    // Оба замороженных канала (x эпохи A, rotate эпохи B) — в финале C.
    const x = readTranslateX(tokenX!)!;
    expect(f.writes.at(-1)!.value).toBe(`translate(${x}px, 20px) ${tokenRot}`);
  });

  it('css-канал: реентри и registry подхватывают применяемое поколение', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let reentered = false;
    setTrigger((prop, value) => {
      if (prop !== 'width' || value !== '50px' || reentered) return;
      reentered = true;
      // Successor того же css-канала: capture живого прогона во время записи.
      animate(f.el, { width: '200px' }, {
        duration: 100,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      }).cancel(); // отмена сразу: registry обязан хранить applied-поколение
    });

    const controls = animate(f.el, { width: ['0px', '100px'] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    expect(() => controls.seek(500)).not.toThrow();
    expect(reentered).toBe(true);

    // Третий прогон стартует из реестра (_writeBack старого owner + rendered
    // отменённого successor-а): оба обязаны нести '50px', не '0px'.
    setTrigger(undefined);
    animate(f.el, { width: '200px' }, {
      duration: 100,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.drain(16);
    const widths = f.writes.filter((w) => w.prop === 'width').map((w) => w.value);
    const afterReenter = widths.slice(widths.indexOf('50px') + 1);
    expect(afterReenter[0]).toBe('50px'); // старт из applied-поколения реестра
    expect(afterReenter).not.toContain('0px'); // stale-поколение не всплывает
    expect(afterReenter.at(-1)).toBe('200px');
  });

  it('C¹: spring-скорость capture во время записи — поколение записи, не прошлый кадр', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let captureFrom: number | undefined;
    setTrigger((prop, value) => {
      const x = prop === 'transform' ? readTranslateX(value) : undefined;
      // Десятый видимый кадр: скорость пружины ещё велика и меняется быстро —
      // снимок прошлого кадра (16 мс назад) дал бы измеримо другую v0.
      if (x === undefined || Number.isNaN(x) || captureFrom !== undefined) return;
      if (f.writes.filter((w) => w.prop === 'transform').length < 10) return;
      captureFrom = x;
      animate(f.el, { x: 200 }, { spring: SPRING, requestFrame: clock.requestFrame });
    });

    animate(f.el, { x: [0, 100] }, { spring: SPRING, requestFrame: clock.requestFrame });
    // Разогрев dt=0, затем кадры по 16 мс: триггер на 10-м видимом кадре (t=144 мс).
    for (let i = 0; i < 12 && captureFrom === undefined; i++) clock.step(16);
    expect(captureFrom).toBeDefined();
    const tCapture = 0.144;

    // Оракул: инверсия линейного по v0 солвера из первого кадра successor-а
    // (канон continuity-helpers, только публичная поверхность).
    const beforeCount = translateXSeries(f.writes).length;
    clock.step(16); // разогрев successor-а (dt=0 — кадр в точке захвата)
    clock.step(16); // первый содержательный кадр (dt=16 мс)
    const series = translateXSeries(f.writes);
    expect(series.length).toBeGreaterThan(beforeCount);
    const xAtDt = series.at(-1)!;
    const implied = impliedPickupVelocity(SPRING, captureFrom!, 200, xAtDt, 16 / 1000);

    const expected = readCompositorSpring(SPRING, {
      from: 0,
      to: 100,
      v0: 0,
      t: tCapture,
    }).velocity;
    const stale = readCompositorSpring(SPRING, {
      from: 0,
      to: 100,
      v0: 0,
      t: tCapture - 16 / 1000,
    }).velocity;
    // Дискриминация классов: захваченная v0 — аналитическая скорость точки
    // захвата; снимок прошлого кадра отстоит на |expected − stale| ≫ tolerance.
    expect(Math.abs(implied - expected)).toBeLessThan(Math.abs(expected - stale) / 4);
  });

  it('C¹: tween-скорость capture во время записи — производная текущего k', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let captured = false;
    setTrigger((prop, value) => {
      if (prop !== 'transform' || readTranslateX(value) !== 25 || captured) return;
      captured = true; // ease t² при k=0.5: x = 100·0.25 = 25, dx/dt = 100 ед/с
      animate(f.el, { x: 200 }, { spring: SPRING, requestFrame: clock.requestFrame });
    });

    const controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: (t) => t * t,
      requestFrame: clock.requestFrame,
    });
    controls.seek(500);
    expect(captured).toBe(true);

    const beforeCount = translateXSeries(f.writes).length;
    clock.step(16);
    clock.step(16);
    const series = translateXSeries(f.writes);
    expect(series.length).toBeGreaterThan(beforeCount);
    const implied = impliedPickupVelocity(SPRING, 25, 200, series.at(-1)!, 16 / 1000);
    // d/dt [100·(t/1)²] при t=0.5 c = 100 ед/с. Снимок k прошлого кадра дал бы
    // ≈ 96.8 (k=0.484); центральная разность ease — погрешность ≪ 1.
    expect(implied).toBeGreaterThan(99);
    expect(implied).toBeLessThan(101);
  });

  it('C¹: settle-запись tween отдаёт скорость покоя, не производную stale k', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let captured = false;
    setTrigger((prop, value) => {
      if (prop !== 'transform' || value !== 'translateX(100px)' || captured) return;
      captured = true;
      animate(f.el, { x: 300 }, { spring: SPRING, requestFrame: clock.requestFrame });
    });

    const controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: (t) => t * t,
      requestFrame: clock.requestFrame,
    });
    // Mid-flight k=0.5, затем терминальный seek: settle публикует ПОКОЙ.
    // Захват производной по k прошлого поколения дал бы фантомные ~100 ед/с
    // на визуально осевшей поверхности.
    controls.seek(500);
    controls.seek(1000);
    expect(captured).toBe(true);

    const beforeCount = translateXSeries(f.writes).length;
    clock.step(16);
    clock.step(16);
    const series = translateXSeries(f.writes);
    expect(series.length).toBeGreaterThan(beforeCount);
    const implied = impliedPickupVelocity(SPRING, 100, 300, series.at(-1)!, 16 / 1000);
    expect(Math.abs(implied)).toBeLessThan(5);
  });

  it('C¹: settle-запись tween-css отдаёт нулевой ṗ, не производную stale k', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let captured = false;
    setTrigger((prop, value) => {
      if (prop !== 'width' || value !== '100px' || captured) return;
      captured = true;
      animate(f.el, { width: '300px' }, { spring: SPRING, requestFrame: clock.requestFrame });
    });

    const controls = animate(f.el, { width: ['0px', '100px'] }, {
      duration: 1000,
      ease: (t) => t * t,
      requestFrame: clock.requestFrame,
    });
    controls.seek(500);
    controls.seek(1000);
    expect(captured).toBe(true);

    // projectCssV0 из torn-пары {финальный css, mid-flight ṗ} посеял бы
    // successor-у фантомную скорость прогресса на осевшей поверхности.
    const beforeCount = f.writes.filter((w) => w.prop === 'width').length;
    clock.step(16);
    clock.step(16);
    const widthAtDt = parseFloat(
      f.writes.filter((w) => w.prop === 'width').slice(beforeCount).at(-1)!.value,
    );
    const implied = impliedPickupVelocity(SPRING, 100, 300, widthAtDt, 16 / 1000);
    expect(Math.abs(implied)).toBeLessThan(5);
  });

  it('C¹: forced-settle (MAX_FRAMES) зануляет css-ṗ поколения покоя', () => {
    const { f, setTrigger } = hostileEl();
    const clock = makeClock();
    let captured = false;
    setTrigger((prop, value) => {
      if (prop !== 'width' || value !== '300px' || captured) return;
      captured = true;
      animate(f.el, { width: '500px' }, { spring: SPRING, requestFrame: clock.requestFrame });
    });

    // Живой tween-донор даёт spring-successor-у ненулевой засеянный ṗ̂.
    const donor = animate(f.el, { width: ['0px', '100px'] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    donor.seek(500);
    animate(f.el, { width: '300px' }, { spring: SPRING, requestFrame: clock.requestFrame });
    // Часы зажаты в t=0: MAX_FRAMES кадров без прогресса форсируют settle
    // с ещё большим live-ṗ. Опубликованное поколение покоя обязано нести
    // нулевую производную — иначе successor стартует с фантомным импульсом.
    for (let i = 0; i <= 2000; i++) clock.step(0);
    expect(captured).toBe(true);

    const beforeCount = f.writes.filter((w) => w.prop === 'width').length;
    // Явный anchor-тик (dt=0, t successor-а остаётся 0) выравнивает lastTs
    // независимо от того, на какой итерации цикла сработал forced-settle:
    // следующий шаг — ровно первый содержательный кадр dt=16 мс оракула.
    clock.step(0);
    clock.step(16);
    const widthAtDt = parseFloat(
      f.writes.filter((w) => w.prop === 'width').slice(beforeCount).at(-1)!.value,
    );
    const implied = impliedPickupVelocity(SPRING, 300, 500, widthAtDt, 16 / 1000);
    expect(Math.abs(implied)).toBeLessThan(5);
  });
});
