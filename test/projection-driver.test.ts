/**
 * test/projection-driver.test.ts — headless-драйвер ./projection (driver.ts).
 * Классы: Б (контракт драйвера) + В (детерминизм, continuity-differential) +
 * Д (mutation-proof). Спека: §2.3 (модель прогресса §2.3.1, velocity continuity
 * §2.3.2, V0_CAP), §4 (interruption-матрица 4.1/4.3/4.6/4.8), §7.4.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Namespace-import + pick-хелпер (канон test/animate-facade-helpers.ts:9-31) —
 * на заглушке src/projection каждый it падал бы СВОИМ ассертом
 * «createProjection is not a function»: RED for the right reason.
 *
 * Mutation proof:
 *   - v0' := 0 при перехвате (сброс скорости) → bite-test |v_after| >
 *     0.65·|v_before| красный (канон test/motion-value.test.ts:581-637).
 *   - Убрать ренормализацию (v0' := v̂ вместо v̂/(1−p̂)) → пин формулы v0' и
 *     differential «перехват ≡ непрерванной» красные.
 *   - Убрать clampMagnitude(V0_CAP) → пин release у p̂→1 (velocity === 1e4) красный.
 *   - Убрать generation-гард → stale-кадр старого полёта эмитит отрицательный tx
 *     после перехвата → «stale-кадры инертны» красный.
 *   - settle() эмитит последний p вместо ровно 1 → «точный identity» красный.
 *   - onRest в cancel() → «cancel без onRest» красный.
 *   - clamp default true → пин «overshoot эмитится в кадры» красный.
 *   - Снап reduce через кадры rAF → «ноль rAF» красный.
 *   - Убрать ребейз radii.first/opacity.from в release()/pickup → C⁰-пины
 *     «первый кадр release: radius 12px, opacity 0.5» красные.
 *   - Убрать мгновенный settle нулевого диапазона в release() → пин «release
 *     после rest: один синхронный кадр, ноль rAF» красный (пружина прогналась бы).
 *   - Не сбрасывать lastTs на кадре без ts (двойной счёт времени) → пин
 *     «чередование ts/без-ts ≡ прогону на FIXED_DT» красный.
 *   - seek() на девственном контроллере переводит playing → пин no-op красный.
 */

import { describe, expect, it } from 'vitest';
import * as projection from '../src/projection/index.js';
import { MotionParamError } from '../src/errors.js';
import {
  makeClock,
  pickCreateProjection,
  pickMixBox,
  reduceMedia,
  type BoxRadiiLike,
  type ProjectionFrameLike,
  type RectLike,
} from './projection-helpers.js';

const mod = projection as unknown as Record<string, unknown>;
const createProjection = pickCreateProjection(mod);
const mixBox = pickMixBox(mod);

const F: RectLike = { x: 0, y: 0, width: 100, height: 100 };
const L: RectLike = { x: 200, y: 0, width: 100, height: 100 };

/** Копия кадра (массив кадров переиспользуется драйвером — ссылку не держим). */
function snap(f: ProjectionFrameLike): {
  id: string;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  opacity: number | undefined;
} {
  return { id: f.id, tx: f.tx, ty: f.ty, sx: f.sx, sy: f.sy, opacity: f.opacity };
}

describe('projection/driver: полёт до точного identity', () => {
  it('первый кадр синхронный (анти-мигание), финал — РОВНО identity, onRest один раз', () => {
    const clock = makeClock();
    const frames: ReturnType<typeof snap>[] = [];
    let rests = 0;
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => frames.push(snap(fr[0])),
      onRest: () => rests++,
    });
    controls.play([{ id: 'a', first: F, last: L }]);

    // Первый кадр — синхронно при play, у инверсии (p=0).
    expect(frames.length).toBe(1);
    expect(frames[0].tx).toBe(-200);
    expect(controls.playing).toBe(true);

    clock.drain(16);
    expect(rests).toBe(1);
    const last = frames[frames.length - 1];
    // finish(): эмит РОВНО p=1 → точный identity (не «почти»).
    expect(last.tx).toBe(0);
    expect(last.ty).toBe(0);
    expect(last.sx).toBe(1);
    expect(last.sy).toBe(1);
    expect(controls.playing).toBe(false);
    expect(controls.progress).toBe(1);
    expect(controls.velocity).toBe(0);

    // Дополнительные тики не дают второго onRest и новых кадров.
    const count = frames.length;
    clock.step(16);
    clock.step(16);
    expect(rests).toBe(1);
    expect(frames.length).toBe(count);
  });

  it('без requestFrame — синхронный finish (identity + onRest), не бросает (§4.8)', () => {
    const frames: ReturnType<typeof snap>[] = [];
    let rests = 0;
    const controls = createProjection({
      onFrame: (fr: readonly ProjectionFrameLike[]) => frames.push(snap(fr[0])),
      onRest: () => rests++,
    });
    expect(() => controls.play([{ id: 'a', first: F, last: L }])).not.toThrow();
    expect(rests).toBe(1);
    expect(controls.playing).toBe(false);
    expect(frames[frames.length - 1].tx).toBe(0);
    expect(frames[frames.length - 1].sx).toBe(1);
  });
});

describe('projection/driver: детерминизм', () => {
  it('два прогона бит-в-бит (P3)', () => {
    const run = (): number[] => {
      const clock = makeClock();
      const txs: number[] = [];
      const controls = createProjection({
        requestFrame: clock.requestFrame,
        onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
      });
      controls.play([{ id: 'a', first: F, last: L }]);
      clock.drain(16);
      return txs;
    };
    expect(run()).toEqual(run());
  });
});

describe('projection/driver: перехват (velocity continuity, §2.3.2 + §4.1)', () => {
  it('полёт ТОЛЬКО по opacity/radii: перехват не теряет скорость (radii/opacity — полноправные каналы скана)', () => {
    // Боксы неподвижны — живой диапазон только у opacity. Мутация «скан без
    // radii/opacity» → v0'=0 → RED (velocity после перехвата обнуляется).
    const clock = makeClock();
    const controls = createProjection({ requestFrame: clock.requestFrame, onFrame: () => {} });
    const BOX = { x: 0, y: 0, width: 100, height: 100 };
    const node = { id: 'a', first: BOX, last: BOX, opacity: { from: 0, to: 1 } };
    controls.play([node]);
    clock.step(16);
    clock.step(16);
    clock.step(16);
    const vBefore = controls.velocity;
    expect(Math.abs(vBefore)).toBeGreaterThan(0);
    // Перехват с теми же целями: теорема → v0' = v̂/(1−p̂), скорость живёт.
    controls.play([{ id: 'a', last: BOX, opacity: { from: 0, to: 1 } }]);
    const vAfter = controls.velocity;
    expect(Math.abs(vAfter)).toBeGreaterThan(0.65 * Math.abs(vBefore));
  });

  it('bite-test: |v_after| > 0.65·|v_before| (канон motion-value smooth pickup)', () => {
    const dtMs = 1000 / 120;
    const dtS = dtMs / 1000;
    const clock = makeClock();
    const txs: number[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    for (let i = 0; i < 8; i++) clock.step(dtMs);

    const velBefore = (txs[txs.length - 1] - txs[txs.length - 2]) / dtS;
    expect(Math.abs(velBefore)).toBeGreaterThan(50); // пружина в живой фазе

    // Перехват на НОВУЮ цель; first опущен → visual pickup (аналитический V(p̂)).
    controls.play([{ id: 'a', last: { x: 300, y: 0, width: 100, height: 100 } }]);
    const mark = txs.length; // txs[mark−1] — синхронный кадр нового полёта
    clock.step(dtMs); // первый ts-кадр без базы → elapsed' = FIXED_DT (один шаг)
    clock.step(dtMs); // кадр с elapsed' = FIXED_DT + dt
    const velAfter = (txs[mark + 1] - txs[mark]) / dtS;

    expect(Number.isFinite(velAfter)).toBe(true);
    // Мутация «v0'=0» → пружина стартует из покоя → velAfter ≈ 0 → красный.
    expect(Math.abs(velAfter)).toBeGreaterThan(Math.abs(velBefore) * 0.65);
  });

  it('пин формулы: сразу после перехвата с неизменной целью velocity = v̂/(1−p̂)', () => {
    const clock = makeClock();
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: () => {},
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    for (let i = 0; i < 8; i++) clock.step(16);
    const pHat = controls.progress; // до overshoot progress ≡ сырому p̂
    const vHat = controls.velocity;
    expect(pHat).toBeGreaterThan(0.05);
    expect(pHat).toBeLessThan(0.95);
    expect(Math.abs(vHat)).toBeGreaterThan(0.1);

    controls.play([{ id: 'a', last: L }]); // цели не менялись → v0' = v̂/(1−p̂)
    expect(controls.velocity).toBeCloseTo(vHat / (1 - pHat), 6);
  });

  it('differential: перехват с неизменными целями ≡ непрерванной траектории (точный C¹, теорема §2.3.2)', () => {
    const INTERCEPT_PUMP = 8;
    // Шаг часов = FIXED_DT: первый ts-кадр каждого прогона (без базы) даёт ровно
    // FIXED_DT — сетки прерванного и непрерванного полёта совпадают по узлам.
    const STEP = 1000 / 60;
    const run = (intercept: boolean): number[] => {
      const clock = makeClock();
      const txs: number[] = [];
      const controls = createProjection({
        requestFrame: clock.requestFrame,
        onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
      });
      controls.play([{ id: 'a', first: F, last: L }]);
      for (let pump = 1; pump <= 30; pump++) {
        clock.step(STEP);
        if (intercept && pump === INTERCEPT_PUMP) {
          controls.play([{ id: 'a', last: L }]); // те же цели, first опущен
        }
      }
      return txs;
    };
    const plain = run(false);
    const picked = run(true);

    // Индексация: plain[k] — кадр с elapsed k·STEP (e0 — синхронный, первый
    // ts-кадр без базы = FIXED_DT = STEP). Перехват на pump 8: picked[9] —
    // синхронный кадр pickup (C⁰ ≡ plain[8]), picked[9+j] (j≥1) — кадр нового
    // полёта с elapsed' j·STEP ≡ plain[j+8].
    expect(picked[9]).toBeCloseTo(plain[8], 9); // C⁰: pickup без скачка
    for (let j = 1; j <= 15; j++) {
      expect(picked[9 + j], `кадр j=${j} после перехвата`).toBeCloseTo(plain[j + 8], 7);
    }
  });

  it('живой id без first валиден; НОВЫЙ id без first → LM078', () => {
    const clock = makeClock();
    const controls = createProjection({ requestFrame: clock.requestFrame, onFrame: () => {} });
    controls.play([{ id: 'a', first: F, last: L }]);
    clock.step(16);
    expect(() => controls.play([{ id: 'a', last: L }])).not.toThrow();
    expect(() =>
      controls.play([
        { id: 'a', last: L },
        { id: 'new', last: L },
      ]),
    ).toThrow(MotionParamError);
    expect(() =>
      controls.play([
        { id: 'a', last: L },
        { id: 'new', last: L },
      ]),
    ).toThrow('LM078');
  });

  it('play без first на новый id без полёта — стабильный код MotionParamError', () => {
    const controls = createProjection();
    expect(() => controls.play([{ id: 'x', last: L }])).toThrow(MotionParamError);
    expect(() => controls.play([{ id: 'x', last: L }])).toThrow('LM078');
  });

  it('stale-кадры старого полёта инертны (generation-гард, канон flip :210-227)', () => {
    // Старый полёт: tx ∈ [−200, 0). Новый (реверс, явный first): ранние tx ≥ 0.
    // Если stale-кадр старого эмитит после перехвата — отрицательный tx → RED.
    const clock = makeClock();
    const txs: number[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    clock.step(16); // старый полёт запланировал следующий кадр
    controls.play([
      { id: 'a', first: { x: 200, y: 0, width: 100, height: 100 }, last: { x: 0, y: 0, width: 100, height: 100 } },
    ]);
    const marker = txs.length;
    clock.step(16); // в очереди И stale-кадр старого, И кадр нового
    clock.step(16);
    const after = txs.slice(marker);
    expect(after.length).toBeGreaterThan(0);
    for (const tx of after) expect(tx).toBeGreaterThanOrEqual(0);
  });
});

describe('projection/driver: V0_CAP (потолок ренормализованной скорости)', () => {
  it('release у p̂→1: v0 = clampMagnitude(v/(1−p), 1e4) — ровно V0_CAP, кадры конечны', () => {
    const clock = makeClock();
    const txs: number[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    controls.seek(0.99999);
    controls.release(3); // 3/(1−0.99999) = 3e5 → потолок 1e4
    expect(controls.velocity).toBe(10000);
    clock.drain(16);
    for (const tx of txs) expect(Number.isFinite(tx)).toBe(true);
  });

  it('знак сохраняется: release(−3) у p̂→1 → −V0_CAP', () => {
    const controls = createProjection({ requestFrame: makeClock().requestFrame, onFrame: () => {} });
    controls.play([{ id: 'a', first: F, last: L }]);
    controls.seek(0.99999);
    controls.release(-3);
    expect(controls.velocity).toBe(-10000);
  });
});

describe('projection/driver: seek/release (§4.6)', () => {
  it('seek: пружина погашена, синхронный эмит на p; сырой p при clamp:false; floor размеров', () => {
    const clock = makeClock();
    const frames: Array<{ id: string; tx: number; sx: number }>[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) =>
        frames.push(fr.map((f) => ({ id: f.id, tx: f.tx, sx: f.sx }))),
    });
    controls.play([
      { id: 'a', first: F, last: L },
      { id: 'b', first: { x: 0, y: 0, width: 100, height: 100 }, last: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    clock.step(16);

    const before = frames.length;
    controls.seek(0.5);
    expect(frames.length).toBe(before + 1); // синхронный эмит
    const at05 = frames[frames.length - 1].find((f) => f.id === 'a')!;
    expect(at05.tx).toBeCloseTo(-100, 9);
    expect(controls.progress).toBe(0.5);

    // Пружина погашена: stale-кадры полёта больше не эмитят.
    const afterSeek = frames.length;
    clock.step(16);
    clock.step(16);
    expect(frames.length).toBe(afterSeek);

    // Сырой p вне [0,1] при clamp:false (дефолт): overshoot эмитится…
    controls.seek(1.1);
    const over = frames[frames.length - 1].find((f) => f.id === 'a')!;
    expect(over.tx).toBeCloseTo(20, 9); // mix(0,200,1.1) − 200 = +20
    // …но публичный progress клампится [0,1] (канон flip :220).
    expect(controls.progress).toBe(1);

    controls.seek(-0.2);
    const under = frames[frames.length - 1].find((f) => f.id === 'a')!;
    expect(under.tx).toBeCloseTo(-240, 9);
    expect(controls.progress).toBe(0);

    // Floor размеров на скрабе: сжимающийся узел не зеркалится.
    controls.seek(1.15);
    const floored = frames[frames.length - 1].find((f) => f.id === 'b')!;
    expect(floored.sx).toBe(0); // w: 100→10, на 1.15 = −3.5 → floor 0
  });

  it('seek валиден и после rest', () => {
    const clock = makeClock();
    const txs: number[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    clock.drain(16);
    const count = txs.length;
    controls.seek(0.25);
    expect(txs.length).toBe(count + 1);
    expect(txs[txs.length - 1]).toBeCloseTo(-150, 9);
    expect(controls.progress).toBe(0.25);
  });

  it('release: C¹ относительно жеста — v0 = v/(1−p_seek); NaN→0; доезд до identity + onRest', () => {
    const clock = makeClock();
    let rests = 0;
    const txs: number[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
      onRest: () => rests++,
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    controls.seek(0.5);
    controls.release(2);
    expect(controls.velocity).toBe(4); // 2/(1−0.5)
    clock.drain(16);
    expect(rests).toBe(1);
    expect(txs[txs.length - 1]).toBe(0); // точный identity

    controls.seek(0.5);
    controls.release(NaN); // NaN → 0 (спека §2.2)
    expect(controls.velocity).toBe(0);
    controls.seek(0.5);
    controls.release(); // default 0
    expect(controls.velocity).toBe(0);
  });
});

describe('projection/driver: C⁰ radii/opacity при release/pickup (ребейз каналов)', () => {
  const flat = (v: number): BoxRadiiLike => [
    { x: v, y: v },
    { x: v, y: v },
    { x: v, y: v },
    { x: v, y: v },
  ];
  const RADII_0 = flat(0);
  const RADII_24 = flat(24);
  // Размер не меняется → кумулятивный k ≡ 1: коррекция радиуса нейтральна,
  // пин читает чистый лерп канала.
  const L_SAME: RectLike = { x: 200, y: 0, width: 100, height: 100 };
  const NODE = {
    id: 'a',
    first: F,
    last: L_SAME,
    radii: { first: RADII_0, last: RADII_24 },
    opacity: { from: 0, to: 1 },
  };

  interface Emitted {
    r0x: number | undefined;
    r0y: number | undefined;
    opacity: number | undefined;
  }
  const collect = (clock: ReturnType<typeof makeClock>): {
    emitted: Emitted[];
    controls: ReturnType<typeof createProjection>;
  } => {
    const emitted: Emitted[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) =>
        emitted.push({ r0x: fr[0].radii?.[0].x, r0y: fr[0].radii?.[0].y, opacity: fr[0].opacity }),
    });
    return { emitted, controls };
  };

  it('seek(0.5) при radii {0→24} / opacity {0→1} → release: первый кадр эмитит radius 12px и opacity 0.5 (не 0)', () => {
    const clock = makeClock();
    const { emitted, controls } = collect(clock);
    controls.play([NODE]);
    controls.seek(0.5);
    const mark = emitted.length;
    controls.release(0);
    // Первый кадр release — синхронный (p=0 нового прогона): каналы ребейзнуты
    // на p_seek, НЕ отброшены к исходному first (мутация «без ребейза» → 0px/0).
    expect(emitted.length).toBe(mark + 1);
    expect(emitted[mark].r0x).toBe(12);
    expect(emitted[mark].r0y).toBe(12);
    expect(emitted[mark].opacity).toBe(0.5);
    // Цели не тронуты ребейзом: доезд ровно к last/to.
    clock.drain(16);
    expect(emitted[emitted.length - 1].r0x).toBe(24);
    expect(emitted[emitted.length - 1].opacity).toBe(1);
  });

  it('mid-flight pickup (first опущен): radii/opacity стартуют с визуальных V(p̂), переданные .first/.from живого узла игнорируются', () => {
    const clock = makeClock();
    const { emitted, controls } = collect(clock);
    controls.play([NODE]);
    controls.seek(0.5);
    const mark = emitted.length;
    // Перехват: dom-адаптер шлёт «сырые» first-каналы — драйвер обязан заменить
    // их аналитикой предыдущего полёта (C⁰ radii/opacity, спека §2.3.2).
    controls.play([
      {
        id: 'a',
        last: { x: 400, y: 0, width: 100, height: 100 },
        radii: { first: RADII_0, last: RADII_24 },
        opacity: { from: 0, to: 1 },
      },
    ]);
    expect(emitted.length).toBe(mark + 1); // синхронный кадр нового полёта
    expect(emitted[mark].r0x).toBe(12); // lerp(0, 24, p̂=0.5), не 0
    expect(emitted[mark].opacity).toBe(0.5); // lerp(0, 1, p̂=0.5), не 0
  });
});

describe('projection/driver: release в/у покоя — без фантомного полёта и дубля onRest', () => {
  it('release после естественного rest — no-op (phase rest: жеста нет, глушить нечего)', () => {
    const clock = makeClock();
    let rests = 0;
    const frames: ReturnType<typeof snap>[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => frames.push(snap(fr[0])),
      onRest: () => rests++,
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    clock.drain(16);
    expect(rests).toBe(1); // естественный rest

    const rafBefore = clock.rafCalls();
    const before = frames.length;
    controls.release(5);
    // Контракт phase-машины: release валиден только для удержанного/живого
    // полёта; в покое — no-op (ни эмитов, ни дубля onRest, ни velocity=V0_CAP).
    expect(frames.length).toBe(before);
    expect(rests).toBe(1);
    expect(controls.playing).toBe(false);
    expect(controls.velocity).toBe(0);
    expect(controls.progress).toBe(1);
    expect(clock.rafCalls()).toBe(rafBefore); // ноль rAF
  });

  it('seek(1) → release — мгновенный settle: один кадр-identity, один onRest, ноль rAF', () => {
    const clock = makeClock();
    let rests = 0;
    const frames: ReturnType<typeof snap>[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => frames.push(snap(fr[0])),
      onRest: () => rests++,
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    clock.step(16);
    controls.seek(1); // жест довёл ровно до цели и держит
    const rafBefore = clock.rafCalls();
    const before = frames.length;
    controls.release(5);
    // remaining = 0: нормализовать скорость не к чему — settle без пружинного
    // прогона (мутация «убрать settle» → фантомный полёт с v0=V0_CAP).
    expect(frames.length).toBe(before + 1);
    expect(frames[frames.length - 1].tx).toBe(0);
    expect(frames[frames.length - 1].sx).toBe(1);
    expect(rests).toBe(1);
    expect(controls.playing).toBe(false);
    expect(controls.velocity).toBe(0);
    expect(clock.rafCalls()).toBe(rafBefore); // ноль rAF
    clock.step(16);
    expect(frames.length).toBe(before + 1); // ничего не запланировано
    expect(rests).toBe(1);
  });
});

describe('projection/driver: стык кадров с ts и без — без двойного счёта времени', () => {
  it('чередование ts/без-ts ≡ прогону целиком на FIXED_DT (каждый кадр — ровно один шаг)', () => {
    const run = (alternate: boolean): number[] => {
      let queue: Array<(ts?: number) => void> = [];
      const txs: number[] = [];
      const controls = createProjection({
        requestFrame: (cb: (ts?: number) => void): number => {
          queue.push(cb);
          return queue.length;
        },
        onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
      });
      controls.play([{ id: 'a', first: F, last: L }]);
      let now = 0;
      for (let i = 0; i < 40 && queue.length > 0; i++) {
        const batch = queue;
        queue = [];
        now += 16;
        // Кадр без ts сбрасывает ts-базу → следующий ts-кадр тоже шагает на
        // FIXED_DT (без сброса он посчитал бы весь интервал, уже покрытый
        // FIXED_DT-шагом, — двойной счёт, эталонная сумма разъехалась бы).
        for (const cb of batch) cb(alternate && i % 2 === 0 ? now : undefined);
      }
      return txs;
    };
    expect(run(true)).toEqual(run(false)); // бит-в-бит: время не удваивается
  });
});

describe('projection/driver: seek на покоящемся контроллере без полёта — no-op (§4.2 контракт)', () => {
  it('play не звался: seek не эмитит, playing/progress/velocity не тронуты', () => {
    let framesSeen = 0;
    const controls = createProjection({ onFrame: () => framesSeen++ });
    expect(() => controls.seek(0.5)).not.toThrow();
    expect(framesSeen).toBe(0); // нечего скрабить — ноль эмитов
    expect(controls.playing).toBe(false); // жест НЕ удерживает несуществующий полёт
    expect(controls.progress).toBe(1);
    expect(controls.velocity).toBe(0);
    expect(controls.boxAt('a')).toBeUndefined();
  });
});

describe('projection/driver: boxAt и velocity (аналитика, ноль DOM)', () => {
  it('boxAt mid-flight = mixBox(first, last, p̂) — differential через живой mixBox', () => {
    const clock = makeClock();
    const controls = createProjection({ requestFrame: clock.requestFrame, onFrame: () => {} });
    controls.play([{ id: 'a', first: F, last: L }]);
    clock.step(16);
    clock.step(16);
    clock.step(16);
    const p = controls.progress; // до overshoot progress ≡ p̂
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(controls.boxAt('a')).toEqual(mixBox(F, L, p));
    expect(controls.boxAt('unknown')).toBeUndefined();
  });

  it('покой: boxAt = last-бокс; velocity = 0; mid-flight velocity ≠ 0', () => {
    const clock = makeClock();
    const controls = createProjection({ requestFrame: clock.requestFrame, onFrame: () => {} });
    controls.play([{ id: 'a', first: F, last: L }]);
    clock.step(16);
    clock.step(16);
    clock.step(16);
    expect(Math.abs(controls.velocity)).toBeGreaterThan(0.1);
    clock.drain(16);
    expect(controls.playing).toBe(false);
    expect(controls.velocity).toBe(0);
    expect(controls.boxAt('a')).toEqual({ ...L });
  });
});

describe('projection/driver: cancel (§4.3)', () => {
  it('глушит без финального эмита и без onRest; идемпотентен', () => {
    const clock = makeClock();
    let rests = 0;
    const txs: number[] = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
      onRest: () => rests++,
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    clock.step(16);
    const count = txs.length;
    controls.cancel();
    expect(controls.playing).toBe(false);
    expect(txs.length).toBe(count); // без финального эмита — визуал замирает
    clock.step(16);
    clock.step(16);
    expect(txs.length).toBe(count);
    expect(rests).toBe(0);
    expect(() => controls.cancel()).not.toThrow(); // идемпотентен
    expect(rests).toBe(0);
  });
});

describe('projection/driver: reduced-motion = CHARACTER-switch (P4)', () => {
  const radiiFirst: BoxRadiiLike = [
    { x: 8, y: 8 },
    { x: 8, y: 8 },
    { x: 8, y: 8 },
    { x: 8, y: 8 },
  ];
  const radiiLast: BoxRadiiLike = [
    { x: 4, y: 2 },
    { x: 6, y: 6 },
    { x: 0, y: 0 },
    { x: 12, y: 10 },
  ];

  it('play → ноль rAF, ОДИН снап-эмит identity (radii=last, opacity=to), onRest', () => {
    const clock = makeClock();
    let rests = 0;
    const emitted: Array<{
      tx: number;
      ty: number;
      sx: number;
      sy: number;
      opacity: number | undefined;
      r0x: number | undefined;
      r3y: number | undefined;
    }> = [];
    const controls = createProjection({
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(),
      onFrame: (fr: readonly ProjectionFrameLike[]) =>
        emitted.push({
          tx: fr[0].tx,
          ty: fr[0].ty,
          sx: fr[0].sx,
          sy: fr[0].sy,
          opacity: fr[0].opacity,
          r0x: fr[0].radii?.[0].x,
          r3y: fr[0].radii?.[3].y,
        }),
      onRest: () => rests++,
    });
    controls.play([
      {
        id: 'a',
        first: F,
        last: L,
        radii: { first: radiiFirst, last: radiiLast },
        opacity: { from: 0, to: 0.7 },
      },
    ]);
    expect(clock.rafCalls()).toBe(0); // ноль кадров rAF
    expect(emitted.length).toBe(1); // один синхронный снап
    expect(emitted[0].tx).toBe(0);
    expect(emitted[0].ty).toBe(0);
    expect(emitted[0].sx).toBe(1);
    expect(emitted[0].sy).toBe(1);
    expect(emitted[0].opacity).toBe(0.7); // opacity = to
    expect(emitted[0].r0x).toBe(radiiLast[0].x); // radii = last (k=1 на p=1)
    expect(emitted[0].r3y).toBe(radiiLast[3].y);
    expect(rests).toBe(1);
    expect(controls.playing).toBe(false);
    expect(controls.progress).toBe(1);
  });

  it('MotionParamError рано даже под reduce: невалидная пружина в фабрике', () => {
    expect(() =>
      createProjection({ spring: { mass: -1, stiffness: 100, damping: 10 } }),
    ).toThrow(MotionParamError);
    expect(() =>
      createProjection({
        spring: { mass: 1, stiffness: NaN, damping: 10 },
        matchMedia: reduceMedia(),
      }),
    ).toThrow(MotionParamError);
  });

  it('MotionParamError рано даже под reduce: невалидные узлы в play', () => {
    const controls = createProjection({ matchMedia: reduceMedia() });
    expect(() => controls.play([{ id: '', first: F, last: L }])).toThrow(MotionParamError);
  });
});

describe('projection/driver: clamp — дефолт FALSE (осознанное отличие от ./flip)', () => {
  const runFlight = (
    options: Record<string, unknown>,
  ): { txs: number[]; progresses: number[] } => {
    const clock = makeClock();
    const txs: number[] = [];
    const progresses: number[] = [];
    const controls = createProjection({
      ...options,
      requestFrame: clock.requestFrame,
      onFrame: (fr: readonly ProjectionFrameLike[]) => txs.push(fr[0].tx),
    });
    controls.play([{ id: 'a', first: F, last: L }]);
    let guard = 0;
    while (clock.pending() > 0 && guard++ < 5000) {
      clock.step(16);
      progresses.push(controls.progress);
    }
    return { txs, progresses };
  };

  it('дефолт: overshoot эмитится в кадры (tx пересекает 0), публичный progress ≤ 1', () => {
    const { txs, progresses } = runFlight({});
    // Пружина {200, 24, 1}: ζ≈0.85 → пик overshoot ≈ +1.3px на диапазоне 200.
    expect(Math.max(...txs)).toBeGreaterThan(0.5);
    for (const p of progresses) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('негативный контроль clamp:true: overshoot в кадры не проходит', () => {
    const { txs } = runFlight({ clamp: true });
    expect(Math.max(...txs)).toBeLessThanOrEqual(0);
  });
});
