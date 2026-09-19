import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import { createBottomSheet, createCarousel } from '../src/behaviors/index.js';
import { makeClock, pt, reduceMedia } from './behaviors-helpers.js';

describe('./behaviors — mutable constraints: bottom sheet', () => {
  it('release retarget сохраняет value/velocity и целевой индекс, старый кадр не оживает', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: [0, 300, 600], requestFrame: clock.requestFrame });
    sheet.snapTo(1);
    clock.step(16);
    clock.step(16);
    const before = sheet.state;
    expect(before.phase).toBe('release');
    expect(Math.abs(before.velocity)).toBeGreaterThan(0);

    const pendingBefore = clock.pending();
    sheet.update([0, 200, 400]);
    expect(clock.pending()).toBe(pendingBefore + 1); // stale old generation + live replacement
    expect(sheet.state.value).toBe(before.value);
    expect(sheet.state.velocity).toBe(before.velocity);
    expect(sheet.state.phase).toBe('release');
    expect(sheet.state.snapIndex).toBe(1);

    // Первый живой кадр обязан наследовать ровно ту velocity, которую отдал
    // invalidated runner; мутант `_invalidate(): return 0` должен стать RED.
    clock.step(16);
    expect(sheet.state.velocity).toBeCloseTo(before.velocity, 9);
    clock.drain(16);
    expect(sheet.state.value).toBeCloseTo(200, 3);
    expect(sheet.state.snapIndex).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it('follow немедленно использует новые границы без смены owner', () => {
    const sheet = createBottomSheet({ snapPoints: [0, 300, 600], rubberBand: 0.5 });
    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 300, 0.1));
    const before = sheet.state.value;
    sheet.update([0, 200, 400]);
    expect(sheet.state.phase).toBe('follow');
    expect(sheet.state.value).toBe(before);
    sheet.pointerMove(pt(0, 300, 0.15));
    expect(sheet.state.value).toBe(before);
    sheet.pointerMove(pt(0, 600, 0.2));
    expect(sheet.state.value).toBeCloseTo(500, 6);
  });


  it('shrink во время follow сразу публикует legal snapIndex', () => {
    const sheet = createBottomSheet({ snapPoints: [0, 100, 200], initial: 200 });
    const seen: number[] = [];
    sheet.subscribe((state) => seen.push(state.snapIndex));
    sheet.pointerDown(pt(0, 200, 0));
    seen.length = 0;

    sheet.update([0, 100]);

    expect(sheet.state).toMatchObject({ phase: 'follow', value: 200, snapIndex: 1 });
    expect(seen).toEqual([1]);
  });

  it('hard clamp при shrink не телепортирует активный follow и не разрешает новый outward overshoot', () => {
    const sheet = createBottomSheet({ snapPoints: [0, 600], rubberBand: 0 });
    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 500, 0.1));
    sheet.update([0, 400]);
    expect(sheet.state.value).toBe(500);
    sheet.pointerMove(pt(0, 500, 0.12));
    expect(sheet.state.value).toBe(500);
    sheet.pointerMove(pt(0, 600, 0.14));
    expect(sheet.state.value).toBe(500);
    sheet.pointerMove(pt(0, 450, 0.16));
    expect(sheet.state.value).toBe(450);
    sheet.pointerMove(pt(0, 350, 0.18));
    expect(sheet.state.value).toBe(350);
  });

  it('settled resize сохраняет логический snap и доводит value к новой геометрии', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: [0, 300, 600], initial: 300, requestFrame: clock.requestFrame });
    sheet.update([0, 180, 360]);
    expect(sheet.state.phase).toBe('release');
    expect(sheet.state.value).toBe(300);
    expect(sheet.state.snapIndex).toBe(1);
    clock.drain(16);
    expect(sheet.state.value).toBeCloseTo(180, 3);
    expect(sheet.state.snapIndex).toBe(1);
  });

  it('identical constraints are idempotent while release is live', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: [0, 300, 600], requestFrame: clock.requestFrame });
    sheet.snapTo(2);
    clock.step(16);
    const before = sheet.state;
    const pending = clock.pending();
    sheet.update([600, 0, 300]);
    expect(sheet.state).toBe(before);
    expect(clock.pending()).toBe(pending);
  });

  it('невалидное обновление атомарно: не меняет ограничения, state или живой runner', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: [0, 300, 600], requestFrame: clock.requestFrame });
    sheet.snapTo(2);
    clock.step(16);
    const before = sheet.state;
    const pending = clock.pending();
    const sparse = Array<number>(3);
    sparse[0] = 0;
    sparse[2] = 600;

    for (const invalid of [[], [0, Number.NaN, 600], [0, Number.POSITIVE_INFINITY, 600], sparse]) {
      expect(() => sheet.update(invalid)).toThrowError(MotionParamError);
      expect(sheet.state).toBe(before);
      expect(clock.pending()).toBe(pending);
    }
  });

  it('конструктор отвергает неконечные и разреженные snap-точки', () => {
    const sparse = Array<number>(2);
    sparse[0] = 0;
    expect(() => createBottomSheet({ snapPoints: [0, Number.NaN] })).toThrowError(MotionParamError);
    expect(() => createBottomSheet({ snapPoints: [0, Number.NEGATIVE_INFINITY] })).toThrowError(MotionParamError);
    expect(() => createBottomSheet({ snapPoints: sparse })).toThrowError(MotionParamError);
  });

  it('reduced-motion использует обновлённые snap без кадров', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({
      snapPoints: [0, 300, 600],
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(true) as unknown as (q: string) => MediaQueryList,
    });
    sheet.update([0, 180, 360]);
    sheet.snapTo(2);
    expect(sheet.state.value).toBe(360);
    expect(clock.rafCalls()).toBe(0);
  });
});

describe('./behaviors — mutable constraints: pager', () => {
  it('release resize сохраняет boundary value/velocity и target index', () => {
    const clock = makeClock();
    const pager = createCarousel({ pageCount: 4, pageSize: 200, requestFrame: clock.requestFrame });
    pager.goTo(3);
    clock.step(16);
    clock.step(16);
    const before = pager.state;
    expect(before.phase).toBe('release');

    const pendingBefore = clock.pending();
    pager.update(4, 120);
    expect(clock.pending()).toBe(pendingBefore + 1); // stale old generation + live replacement
    expect(pager.state.value).toBe(before.value);
    expect(pager.state.velocity).toBe(before.velocity);
    expect(pager.state.phase).toBe('release');
    // То же mutation-proof для pager: первый replacement-frame сохраняет C¹.
    clock.step(16);
    expect(pager.state.velocity).toBeCloseTo(before.velocity, 9);
    clock.drain(16);
    expect(pager.state.value).toBeCloseTo(360, 3);
    expect(pager.state.index).toBe(3);
    expect(clock.pending()).toBe(0);
  });

  it('уменьшение pageCount во время release клэмпит прежний target', () => {
    const clock = makeClock();
    const pager = createCarousel({ pageCount: 4, pageSize: 200, requestFrame: clock.requestFrame });
    pager.goTo(3);
    clock.step(16);
    pager.update(2, 120);
    clock.drain(16);
    expect(pager.state.index).toBe(1);
    expect(pager.state.value).toBeCloseTo(120, 3);
  });

  it('follow после resize использует новую геометрию и остаётся одним жестом', () => {
    const pager = createCarousel({ pageCount: 4, pageSize: 200, index: 1 });
    pager.pointerDown(pt(0, 0, 0));
    pager.pointerMove(pt(-40, 0, 0.1));
    const before = pager.state.value;
    expect(before).toBe(240);
    pager.update(4, 120);
    expect(pager.state.phase).toBe('follow');
    expect(pager.state.value).toBe(before);
    expect(pager.state.index).toBe(2);
    pager.pointerMove(pt(-40, 0, 0.15));
    expect(pager.state.value).toBe(before);
    pager.pointerMove(pt(-60, 0, 0.2));
    expect(pager.state.value).toBe(260);
    expect(pager.state.index).toBe(2);
  });

  it('resize во время follow переводит swipe anchor в новую index-геометрию', () => {
    const pager = createCarousel({ pageCount: 4, pageSize: 200, index: 2, velocityThreshold: 1 });
    pager.pointerDown(pt(0, 0, 0));
    pager.update(8, 100);

    // После resize текущая позиция 400 px соответствует странице 4. Быстрый флик
    // вправо в position-space может уйти только на соседнюю страницу 5, не к старому anchor=2.
    pager.pointerMove(pt(-20, 0, 0.1));
    pager.pointerUp(pt(-40, 0, 0.2));

    // Без нового anchor target ограничивался бы [1,3], и synchronous path сел бы на 3.
    expect(pager.state.value).toBe(500);
    expect(pager.state.index).toBe(5);
  });

  it('shrink во время follow сразу публикует legal index ровно через owner', () => {
    const pager = createCarousel({ pageCount: 4, pageSize: 100, index: 3 });
    const seen: number[] = [];
    pager.subscribe((state) => seen.push(state.index));
    pager.pointerDown(pt(0, 0, 0));
    seen.length = 0;

    pager.update(2, 100);

    expect(pager.state).toMatchObject({ phase: 'follow', value: 300, index: 1 });
    expect(seen).toEqual([1]);
  });

  it('shrink вне follow сразу клэмпит опубликованный index даже перед cancel', () => {
    const clock = makeClock();
    const pager = createCarousel({
      pageCount: 4,
      pageSize: 100,
      index: 3,
      requestFrame: clock.requestFrame,
    });

    pager.update(2, 100);
    expect(pager.state.index).toBe(1);
    pager.cancel();
    expect(pager.state).toMatchObject({ index: 1, phase: 'idle' });
  });

  it('resize после cancel не восстанавливает отменённый target', () => {
    const clock = makeClock();
    const pager = createCarousel({ pageCount: 4, pageSize: 100, requestFrame: clock.requestFrame });
    pager.goTo(3);
    expect(pager.state).toMatchObject({ phase: 'release', index: 0, value: 0 });

    pager.cancel();
    expect(pager.state).toMatchObject({ phase: 'idle', index: 0, value: 0 });

    pager.update(4, 120);
    clock.drain(16);
    expect(pager.state.index).toBe(0);
    expect(pager.state.value).toBeCloseTo(0, 3);
  });

  it('settled resize сохраняет logical page и доводит position к новому pageSize', () => {
    const clock = makeClock();
    const pager = createCarousel({ pageCount: 4, pageSize: 200, index: 2, requestFrame: clock.requestFrame });
    pager.update(4, 120);
    expect(pager.state.phase).toBe('release');
    expect(pager.state.value).toBe(400);
    clock.drain(16);
    expect(pager.state.index).toBe(2);
    expect(pager.state.value).toBeCloseTo(240, 3);
  });

  it('identical page geometry is idempotent while release is live', () => {
    const clock = makeClock();
    const pager = createCarousel({ pageCount: 4, pageSize: 200, requestFrame: clock.requestFrame });
    pager.goTo(3);
    clock.step(16);
    const before = pager.state;
    const pending = clock.pending();
    pager.update(4, 200);
    expect(pager.state).toBe(before);
    expect(clock.pending()).toBe(pending);
  });

  it('RTL release и reduced-motion сохраняются после update', () => {
    const clock = makeClock();
    const rtl = createCarousel({ pageCount: 3, pageSize: 200, index: 1, rtl: true, requestFrame: clock.requestFrame });
    rtl.pointerDown(pt(0, 0, 0));
    rtl.pointerMove(pt(-120, 0, 0.05));
    rtl.pointerUp(pt(-120, 0, 0.05));
    rtl.update(3, 120);
    clock.drain(16);
    expect(rtl.state.index).toBe(0);
    expect(rtl.state.value).toBeCloseTo(0, 3);

    const reducedClock = makeClock();
    const reduced = createCarousel({
      pageCount: 3,
      pageSize: 200,
      requestFrame: reducedClock.requestFrame,
      matchMedia: reduceMedia(true) as unknown as (q: string) => MediaQueryList,
    });
    reduced.update(3, 120);
    reduced.goTo(2);
    expect(reduced.state.value).toBe(240);
    expect(reducedClock.rafCalls()).toBe(0);
  });

  it('невалидное обновление атомарно и не прерывает живой runner', () => {
    const clock = makeClock();
    const pager = createCarousel({ pageCount: 3, pageSize: 200, requestFrame: clock.requestFrame });
    pager.goTo(2);
    clock.step(16);
    const before = pager.state;
    const pending = clock.pending();

    for (const [count, size] of [
      [0, 120], [2.5, 120], [Number.POSITIVE_INFINITY, 120],
      [3, 0], [3, Number.NaN], [3, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => pager.update(count, size)).toThrowError(MotionParamError);
      expect(pager.state).toBe(before);
      expect(clock.pending()).toBe(pending);
    }
  });

  it('конструктор использует тот же строгий контракт геометрии', () => {
    expect(() => createCarousel({ pageCount: 2.5, pageSize: 200 })).toThrowError(MotionParamError);
    expect(() => createCarousel({ pageCount: Number.POSITIVE_INFINITY, pageSize: 200 })).toThrowError(MotionParamError);
    expect(() => createCarousel({ pageCount: 3, pageSize: Number.NaN })).toThrowError(MotionParamError);
    expect(() => createCarousel({ pageCount: 3, pageSize: Number.POSITIVE_INFINITY })).toThrowError(MotionParamError);
  });
});
