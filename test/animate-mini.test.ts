/**
 * test/animate-mini.test.ts — характеризация лёгкого среза ./animate/mini.
 *
 * Дисциплина: duck-typed фейки (без jsdom), детерминированный шаг-клок как
 * инжектированный requestFrame единого ./frame, seeded-инварианты. Каждый тест
 * пинует ОДИН инвариант контракта mini; в докблоке — вневременной факт падения
 * (RED, если инвариант сломать), подтверждённый mutation-пробой (см. отчёт PR).
 *
 * MUTATION PROOF-якоря (каждый мутант кусает ИМЕННО эти тесты):
 *   - слом fail-fast невалидного значения → 'fail-fast: NaN пишет стиль';
 *   - потеря velocity-подхвата → 'C¹-подхват: скорость переносится';
 *   - слом единой семантики времени → 'единая семантика: spring и tween — один клок';
 *   - слом residual-transform → 'остаточный transform не сбрасывается';
 *   - слом reduced-снапа → 'reduced-motion: снап без кадров';
 *   - слом фазы render (запись) → 'настройка не пишет до кадра'.
 *
 * MUTATION PROOF (2026-07-10): 11 мутантов прогнаны, КАЖДЫЙ кусается, откачены —
 *   M1 реестр→fallback-switch; M2 потеря velocity-подхвата; M3 слом fail-fast;
 *   M4 mini тянет full (size-гейт 6119 > 5120); M5 слом фазы render; M6 слом
 *   reduced-снапа; M7 plain-object касается DOM; M8 слом единой семантики времени
 *   (settle p=0); M9 слом residual-transform; M10 SVG мимо setAttribute; M11 слом
 *   stagger-сдвига. Ни одного survived.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import { animate } from '../src/animate/mini/index.js';
import { fakeEl, makeClock, translateXSeries } from './animate-facade-helpers.js';

const RF = (clock: ReturnType<typeof makeClock>) => ({ requestFrame: clock.requestFrame });

describe('mini — базовая анимация', () => {
  it('spring transform x оседает в точной цели', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const c = animate(f.el, { x: 120 }, RF(clock));
    clock.drain(16);
    await c.finished;
    expect(f.writes.filter((w) => w.prop === 'transform').at(-1)?.value).toBe('translateX(120px)');
  });

  it('tween opacity оседает в цели за duration', async () => {
    const f = fakeEl({ opacity: '0' });
    const clock = makeClock();
    const c = animate(f.el, { opacity: 1 }, { ...RF(clock), duration: 100 });
    clock.drain(16);
    await c.finished;
    expect(f.writes.filter((w) => w.prop === 'opacity').at(-1)?.value).toBe('1');
  });

  it('несколько transform-каналов сливаются в одну строку', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const c = animate(f.el, { x: 10, y: 20, rotate: 45 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    const last = f.writes.filter((w) => w.prop === 'transform').at(-1)!.value;
    // Формат байт-в-байт совпадает с ядровым buildTransform (x&y → translate()).
    expect(last).toBe('translate(10px, 20px) rotate(45deg)');
    // Одна декларация transform на кадр (не три отдельные записи).
    const firstFrameProps = new Set(f.writes.map((w) => w.prop));
    expect(firstFrameProps).toEqual(new Set(['transform']));
  });

  it('CSS-переменная анимируется с юнитом', async () => {
    const f = fakeEl({});
    const clock = makeClock();
    const c = animate(f.el, { '--gap': ['0px', '16px'] }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    const w = f.writes.filter((x) => x.prop === '--gap').at(-1)!;
    expect(w.value).toBe('16px');
  });
});

describe('mini — настройка не пишет до кадра (фаза render)', () => {
  // RED без разведения фаз/ленивого старта: запись случилась бы синхронно в
  // конструкторе. Инвариант: чтение сделано в bind, запись — в render-фазе кадра.
  it('настройка не пишет до кадра', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100 }, RF(clock));
    // До первого step() — ни одной записи (шедулер ленивый, запись в render).
    expect(f.writes.length).toBe(0);
    clock.step(16);
    expect(f.writes.length).toBeGreaterThan(0);
  });
});

describe('mini — fail-fast (валидация ДО записи)', () => {
  it('fail-fast: NaN пишет стиль', () => {
    const f = fakeEl();
    expect(() => animate(f.el, { x: NaN as number })).toThrow(MotionParamError);
    // Ни одной записи в стиль (бросок раньше побочных эффектов).
    expect(f.writes.length).toBe(0);
  });

  it("'transform' целиком запрещён (шортхенды)", () => {
    const f = fakeEl();
    expect(() => animate(f.el, { transform: 'translateX(1px)' } as never)).toThrow(MotionParamError);
    expect(f.writes.length).toBe(0);
  });

  it('spring и duration одновременно — ошибка', () => {
    const f = fakeEl();
    expect(() =>
      animate(f.el, { x: 1 }, { spring: { mass: 1, stiffness: 100, damping: 10 }, duration: 100 }),
    ).toThrow(MotionParamError);
  });

  it('отрицательный delay — ошибка до записи', () => {
    const f = fakeEl();
    expect(() => animate(f.el, { x: 1 }, { delay: -5 })).toThrow(MotionParamError);
    expect(f.writes.length).toBe(0);
  });
});

describe('mini — SSR-safe', () => {
  it('селектор без document бросает MotionParamError (не ReferenceError)', () => {
    // В node globalThis.document отсутствует — путь резолвится в момент вызова.
    expect(() => animate('.hero', { x: 1 })).toThrow(MotionParamError);
  });

  it('duck-элемент анимируется без document/window', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const c = animate(f.el, { x: 5 }, { ...RF(clock), duration: 32 });
    clock.drain(16);
    await c.finished;
    expect(f.writes.length).toBeGreaterThan(0);
  });
});

describe('mini — delay и stagger', () => {
  it('delay откладывает старт движения', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const c = animate(f.el, { x: 100 }, { ...RF(clock), duration: 100, delay: 200 });
    // Первые кадры — в окне задержки: значение держится у from (0 → 'none').
    clock.step(16);
    clock.step(16);
    const early = translateXSeries(f.writes);
    expect(early.every((v) => v === 0)).toBe(true);
    clock.drain(16);
    await c.finished;
    expect(f.writes.filter((w) => w.prop === 'transform').at(-1)?.value).toBe('translateX(100px)');
  });

  it('stagger сдвигает старт по индексу цели', async () => {
    const a = fakeEl();
    const b = fakeEl();
    const clock = makeClock();
    const c = animate([a.el, b.el], { opacity: [0, 1] }, { ...RF(clock), duration: 100, stagger: 200 });
    clock.step(16);
    clock.step(16);
    // b (индекс 1, delay 200) ещё держит from=0; a уже двинулась.
    const bFirst = b.writes.filter((w) => w.prop === 'opacity').map((w) => Number(w.value));
    expect(bFirst.every((v) => v === 0)).toBe(true);
    clock.drain(16);
    await c.finished;
    expect(b.writes.filter((w) => w.prop === 'opacity').at(-1)?.value).toBe('1');
  });
});

describe('mini — контролы', () => {
  it('cancel останавливает и резолвит finished без onComplete', async () => {
    const f = fakeEl();
    const clock = makeClock();
    let completed = false;
    const c = animate(f.el, { x: 100 }, { ...RF(clock), onComplete: () => (completed = true) });
    clock.step(16);
    const before = f.writes.length;
    c.cancel();
    clock.drain(16);
    await c.finished;
    expect(completed).toBe(false);
    // После cancel новых кадровых записей нет.
    expect(f.writes.length).toBe(before);
  });

  it('pause замораживает, play возобновляет', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const c = animate(f.el, { x: 100 }, { ...RF(clock), duration: 200 });
    clock.step(16);
    c.pause();
    const paused = f.writes.length;
    clock.step(16);
    clock.step(16);
    expect(f.writes.length).toBe(paused); // на паузе кадры не пишут
    c.play();
    clock.drain(16);
    await c.finished;
    expect(f.writes.filter((w) => w.prop === 'transform').at(-1)?.value).toBe('translateX(100px)');
  });

  it('seek немедленно эмитит к виртуальному времени', () => {
    const f = fakeEl();
    const clock = makeClock();
    const c = animate(f.el, { x: 100 }, { ...RF(clock), duration: 100 });
    c.seek(1000); // за пределами duration → снап к финалу
    expect(f.writes.filter((w) => w.prop === 'transform').at(-1)?.value).toBe('translateX(100px)');
    c.cancel();
  });

  it('onComplete зовётся один раз при естественном оседании', async () => {
    const f = fakeEl();
    const clock = makeClock();
    let calls = 0;
    const c = animate(f.el, { opacity: [0, 1] }, { ...RF(clock), duration: 50, onComplete: () => calls++ });
    clock.drain(16);
    await c.finished;
    expect(calls).toBe(1);
  });
});

describe('mini — C¹-подхват при повторном запуске', () => {
  it('повторный animate стартует от текущего значения (континуальность)', async () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100 }, { ...RF(clock), duration: 200 });
    clock.step(16);
    clock.step(16);
    const mid = translateXSeries(f.writes).at(-1)!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    // Перехват к новой цели: первая запись нового прогона ≈ mid (не прыжок к 0/200).
    const c2 = animate(f.el, { x: 200 }, { ...RF(clock), duration: 200 });
    clock.step(16);
    const resumeFirst = translateXSeries(f.writes).at(-1)!;
    expect(Math.abs(resumeFirst - mid)).toBeLessThan(25); // континуально, без скачка
    clock.drain(16);
    await c2.finished;
    expect(f.writes.filter((w) => w.prop === 'transform').at(-1)?.value).toBe('translateX(200px)');
  });

  it('C¹-подхват: скорость переносится', () => {
    // Перехват РАЗГОНЯЮЩЕГОСЯ spring-прогона переносит скорость: ранняя
    // траектория обгоняет свежий старт с той же позиции при v0=0 (explicit from).
    // Спринг — потому что tween игнорирует v0 (у него нет момента); v0 живёт на
    // spring-пути (readCompositorSpring). MUTATION: обнулить velocity в
    // captureChannel/normalizeV0 → обе траектории совпадут в t=16.
    const live = fakeEl();
    const ctl = fakeEl();
    const cl1 = makeClock();
    const cl2 = makeClock();
    animate(live.el, { x: 300 }, RF(cl1)); // default spring — набирает скорость
    cl1.step(16);
    cl1.step(16);
    cl1.step(16);
    const mid = translateXSeries(live.writes).at(-1)!;
    // Перехват живого (несёт скорость v0>0):
    animate(live.el, { x: 400 }, RF(cl1));
    cl1.step(16); // t=0 → from=mid
    cl1.step(16); // t≈16 → spring с v0 обгоняет
    const liveResume = translateXSeries(live.writes).at(-1)! - mid;
    // Контроль: свежий старт с mid, ЯВНЫЙ from → v0=0:
    animate(ctl.el, { x: [mid, 400] }, RF(cl2));
    cl2.step(16);
    cl2.step(16);
    const ctlResume = translateXSeries(ctl.writes).at(-1)! - mid;
    expect(liveResume).toBeGreaterThan(ctlResume);
  });
});

describe('mini — остаточный transform', () => {
  it('остаточный transform не сбрасывается', async () => {
    const f = fakeEl();
    const clock = makeClock();
    // Сначала rotate.
    const c1 = animate(f.el, { rotate: 90 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c1.finished;
    // Теперь x — rotate должен остаться в строке (не откатиться к identity).
    const c2 = animate(f.el, { x: 50 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c2.finished;
    const last = f.writes.filter((w) => w.prop === 'transform').at(-1)!.value;
    expect(last).toContain('rotate(90deg)');
    expect(last).toContain('translateX(50px)');
  });
});

describe('mini — reduced-motion', () => {
  it('reduced-motion: снап без кадров', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const mm = (q: string) => ({ matches: q.includes('reduce') });
    const c = animate(f.el, { x: 100 }, { ...RF(clock), matchMedia: mm });
    // Снап синхронный: финал уже записан, кадры не нужны.
    expect(f.writes.filter((w) => w.prop === 'transform').at(-1)?.value).toBe('translateX(100px)');
    await c.finished;
    // Клок не задействован (ни одного кадра не запланировано драйвером снапа).
    expect(clock.now).toBe(0);
  });
});

describe('mini — единая семантика времени', () => {
  it('единая семантика: spring и tween — один клок [0,1]', async () => {
    // И spring, и tween ведут прогресс в ОДНОМ пространстве [0,1]; оба оседают
    // РОВНО в цели (не за/недолёт из-за расхождения клоков). Keyframe-массивы и
    // per-property (full) наследуют этот же клок. MUTATION: развести клоки →
    // один из путей не сойдётся в точную цель.
    const fs = fakeEl();
    const ft = fakeEl();
    const cs = makeClock();
    const ct = makeClock();
    const a = animate(fs.el, { x: 80 }, RF(cs)); // spring
    const b = animate(ft.el, { x: 80 }, { ...RF(ct), duration: 100 }); // tween
    cs.drain(16);
    ct.drain(16);
    await Promise.all([a.finished, b.finished]);
    expect(fs.writes.filter((w) => w.prop === 'transform').at(-1)?.value).toBe('translateX(80px)');
    expect(ft.writes.filter((w) => w.prop === 'transform').at(-1)?.value).toBe('translateX(80px)');
  });
});
