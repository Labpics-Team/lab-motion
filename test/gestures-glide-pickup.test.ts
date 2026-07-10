/**
 * test/gestures-glide-pickup.test.ts
 * Классы: Б (characterization) + А (contract/bite) + В (fuzz, seeded LCG) +
 *         Д (mutation-proof).
 * Issue: #93 «единый C¹-контракт value+velocity», срез 2, контракт C2b.
 *
 * Зачем: до этого среза pointerDown во время инерционного глайда делал
 * tracker.reset() — скорость глайда ТЕРЯЛАСЬ, и немедленный release без
 * движения убивал движение (release-скорость 0, объект замирал). Это разрыв
 * C¹ при «подхвате летящего объекта» (native-паттерн iOS/Android скроллеров:
 * поймал — держишь; отпустил сразу — полетел дальше). Контракт: скорость
 * активного глайда становится ПРАЙОРОМ нового жеста — трекер засевается через
 * собственную sliding-window механику (синтетический сэмпл на полокна назад
 * вдоль скорости глайда), поэтому:
 *   — немедленный release продолжает движение (наследует скорость);
 *   — удержание пальца естественно вытесняет прайор из окна (скорость → 0);
 *   — реальное движение пальца перекрывает прайор как обычные сэмплы.
 *
 * Контракт:
 *   (1) press→release без движения ВО ВРЕМЯ глайда → |v_after| > 0.65·|v_before|
 *       и тот же знак (bite), позиция продолжает ехать, а НЕ замирает;
 *   (2) удержание дольше окна трекера (0.1s) без движения → release даёт
 *       скорость 0 (прайор вытеснен) — объект остаётся на месте;
 *   (3) движение пальца после захвата задаёт скорость как обычно (прайор
 *       перекрыт настоящими сэмплами);
 *   (4) характеризация: down НЕ во время глайда — прежнее поведение бит-в-бит
 *       (без прайора: release без движения = скорость 0);
 *   (5) финитность эмиссий на злых входах, детерминизм.
 *
 * ОСОЗНАННЫЙ ФИКС ДЕФЕКТА (#93, breaking-заметка в CHANGELOG Unreleased):
 * прежнее наблюдаемое поведение «press→release во время глайда убивает
 * скорость» здесь намеренно заменено наследованием — это дефект C¹-контракта,
 * а не фича; пин прежнего поведения сохранён для случая БЕЗ глайда (4).
 *
 * RED PROOF (вневременно — почему тесты были красными до реализации):
 *   pointerDown безусловно делал tracker.reset() + push(p) — после
 *   press→release без движения в трекере лежала одна пара одинаковых точек
 *   (или одна точка): velocity() = {0,0}, стартовал нулевой глайд, позиция
 *   замирала в кадре release. Bite (1) падал (v_after = 0 < 0.65·v_before),
 *   «позиция продолжает ехать» падал (Δx = 0). RED по правильной причине:
 *   отсутствие прайора, не поломка трекера.
 *
 * Mutation proofs (тест обязан падать на своей мутации):
 *   [seed]      Убрать синтетический сэмпл → bite (1) падает (v_after=0).
 *   [gate]      Сеять всегда (не только при gliding) → characterization (4)
 *               падает (release без движения после обычного down поехал бы).
 *   [decay]     Сеять на полное окно (не полокна) → (2) может выжить, но bite
 *               (1) с release через 1мс падает при вытеснении сэмпла.
 *   [freshness] Не обновлять glideV* по кадрам (заморозить на release) →
 *               bite остаётся, но fuzz-детерминизм и (1) с поздним pickup
 *               ловят завышенную скорость (v_after > v_before·1.05).
 */

import { describe, expect, it } from 'vitest';
import { createDrag } from '../src/gestures/index.js';

// ─── Виртуальный клок (конвенция repo: ts в мс, handle > 0) ────────────────────

function virtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return ++handle;
  };
  const pump = (ts: number): void => {
    const cbs = queue.splice(0);
    for (const cb of cbs) cb(ts);
  };
  return { requestFrame, pump, queue };
}

const FRAME_S = 0.016;

/** Стандартный флик вправо (vx = 1250 px/s на release) с журналом глайд-кадров. */
function flickWithLog(clock: ReturnType<typeof virtualClock>, opts: Parameters<typeof createDrag>[0] = {}) {
  const glide: number[] = [];
  let inGlide = false;
  const d = createDrag({
    requestFrame: clock.requestFrame,
    ...opts,
    onStep: (x, y) => {
      if (inGlide) glide.push(x);
      opts.onStep?.(x, y);
    },
  });
  d.pointerDown({ x: 0, y: 0, t: 0 });
  for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
  d.pointerUp({ x: 100, y: 0, t: 0.08 });
  inGlide = true;
  return { d, glide };
}

// ─── Класс А: bite — pickup летящего объекта ──────────────────────────────────

describe('gestures/drag glide pickup: C¹ при захвате (класс А, bite)', () => {
  it('press→release без движения во время глайда: |v_after| > 0.65·|v_before|, знак тот же — НЕ 0', () => {
    const clock = virtualClock();
    const { d, glide } = flickWithLog(clock);
    // Разгоняем глайд на несколько кадров.
    let ts = 0;
    for (let i = 0; i < 6; i++) {
      clock.pump(ts);
      ts += 16;
    }
    expect(d.gliding).toBe(true);
    const n = glide.length;
    const vBefore = (glide[n - 1] - glide[n - 2]) / FRAME_S; // секанс глайда перед захватом
    expect(vBefore).toBeGreaterThan(100);

    // Захват на месте (палец ловит объект) и немедленный release без движения.
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 });
    expect(d.dragging).toBe(true);
    d.pointerUp({ x: grabX, y: 0, t: 1.001 });
    expect(d.gliding).toBe(true); // движение ПРОДОЛЖИЛОСЬ (новый глайд), не умерло

    // Два кадра нового глайда → секанс после.
    const m = glide.length;
    clock.pump(ts);
    clock.pump(ts + 16);
    const vAfter = (glide[m + 1] - glide[m]) / FRAME_S;

    expect(vAfter).toBeGreaterThan(0); // тот же знак
    expect(Math.abs(vAfter)).toBeGreaterThan(0.65 * Math.abs(vBefore)); // bite: наследование, не 0
    expect(Math.abs(vAfter)).toBeLessThan(1.05 * Math.abs(vBefore)); // и не завышение (freshness)
  });

  it('позиция продолжает ехать после мгновенного pickup→release (в дефолте раньше замирала)', () => {
    const clock = virtualClock();
    const { d } = flickWithLog(clock);
    let ts = 0;
    for (let i = 0; i < 6; i++) {
      clock.pump(ts);
      ts += 16;
    }
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 });
    d.pointerUp({ x: grabX, y: 0, t: 1.001 });
    for (; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.gliding).toBe(false);
    expect(d.x).toBeGreaterThan(grabX + 20); // импульс пронёс дальше точки захвата
    expect(Number.isFinite(d.x)).toBe(true);
  });

  it('pickup во время глайда по ОБЕИМ осям наследует обе компоненты скорости', () => {
    const clock = virtualClock();
    const d = createDrag({ requestFrame: clock.requestFrame });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: -i * 10, t: i * 0.016 });
    d.pointerUp({ x: 100, y: -50, t: 0.08 }); // vx=1250, vy=−625
    let ts = 0;
    for (let i = 0; i < 4; i++) {
      clock.pump(ts);
      ts += 16;
    }
    const grabX = d.x;
    const grabY = d.y;
    d.pointerDown({ x: grabX, y: grabY, t: 1.0 });
    d.pointerUp({ x: grabX, y: grabY, t: 1.001 });
    for (; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBeGreaterThan(grabX); // унаследован +vx
    expect(d.y).toBeLessThan(grabY); // унаследован −vy
  });
});

// ─── Класс А: прайор живёт по правилам окна ───────────────────────────────────

describe('gestures/drag glide pickup: прайор подчиняется sliding-window (класс А)', () => {
  it('удержание пальца дольше окна (0.1s) без движения → release даёт скорость 0: объект остаётся', () => {
    const clock = virtualClock();
    const { d } = flickWithLog(clock);
    let ts = 0;
    for (let i = 0; i < 6; i++) {
      clock.pump(ts);
      ts += 16;
    }
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 });
    d.pointerUp({ x: grabX, y: 0, t: 1.3 }); // 300мс > окна 100мс — прайор вытеснен
    for (; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.gliding).toBe(false);
    expect(d.x).toBe(grabX); // скорость ровно 0: глайд осел в точке захвата
  });

  it('движение пальца после захвата перекрывает прайор: скорость по НОВОМУ движению (обратный знак)', () => {
    const clock = virtualClock();
    const { d } = flickWithLog(clock); // глайд едет вправо
    let ts = 0;
    for (let i = 0; i < 6; i++) {
      clock.pump(ts);
      ts += 16;
    }
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 });
    // Тянем ВЛЕВО дольше окна — прайор (вправо) обязан вылететь из окна.
    for (let i = 1; i <= 8; i++) d.pointerMove({ x: grabX - i * 10, y: 0, t: 1.0 + i * 0.02 });
    const xAtRelease = d.x;
    d.pointerUp({ x: grabX - 80, y: 0, t: 1.16 });
    for (; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBeLessThan(xAtRelease); // глайд поехал влево — знак нового движения
  });
});

// ─── Класс Б: characterization — без глайда прайора нет ───────────────────────

describe('gestures/drag glide pickup: characterization прежнего поведения (класс Б)', () => {
  it('обычный down (БЕЗ глайда) → release без движения: скорость 0, объект не едет (прежнее поведение)', () => {
    const clock = virtualClock();
    let rests = 0;
    const d = createDrag({ requestFrame: clock.requestFrame, onRest: () => rests++ });
    d.pointerDown({ x: 50, y: 50, t: 0 });
    d.pointerUp({ x: 50, y: 50, t: 0.001 });
    for (let ts = 0; ts <= 1000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBe(0); // позиция не менялась (from по умолчанию 0, движения не было)
    expect(d.y).toBe(0);
    expect(rests).toBe(1);
  });

  it('повторный pointerDown во время АКТИВНОГО drag (не глайда) не сеет прайор: якорь перехвачен без скачка', () => {
    const d = createDrag({ inertia: false });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    d.pointerMove({ x: 30, y: 0, t: 0.02 });
    d.pointerDown({ x: 100, y: 0, t: 0.04 }); // ре-захват при dragging (gliding=false)
    d.pointerUp({ x: 100, y: 0, t: 0.041 }); // немедленный release без движения
    expect(d.x).toBeCloseTo(30); // осел где стоял: прайора не было
  });

  it('пин прежнего дефекта снят: два прогона pickup-сценария детерминированы бит-в-бит', () => {
    const run = (): number[] => {
      const clock = virtualClock();
      const { d, glide } = flickWithLog(clock);
      let ts = 0;
      for (let i = 0; i < 6; i++) {
        clock.pump(ts);
        ts += 16;
      }
      d.pointerDown({ x: d.x, y: 0, t: 1.0 });
      d.pointerUp({ x: d.x, y: 0, t: 1.001 });
      for (; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
      return glide;
    };
    expect(run()).toEqual(run());
  });
});

// ─── Класс В: fuzz (seeded LCG — домовой канон) ───────────────────────────────

describe('gestures/drag glide pickup: fuzz злых pickup-сценариев (класс В)', () => {
  it('500 сценариев pickup/release: эмиссии всегда конечны, глайд всегда оседает', () => {
    let s = 0x91c2b0f7;
    const rnd = () => {
      s = (Math.imul(1664525, s) + 1013904223) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, 1e308];
    const pick = (): number => (rnd() < 0.25 ? evil[Math.floor(rnd() * evil.length)] : (rnd() - 0.5) * 1e4);

    for (let run = 0; run < 500; run++) {
      const clock = virtualClock();
      const d = createDrag({
        requestFrame: clock.requestFrame,
        // Горячий путь фазза: throw вместо expect (канон drive-фазза) — миллион
        // эмиссий не должен платить за matcher.
        onStep: (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`non-finite эмиссия: (${x}, ${y}) на прогоне ${run}`);
          }
        },
      });
      // Флик со случайной (иногда злой) кинематикой.
      d.pointerDown({ x: pick(), y: pick(), t: 0 });
      for (let i = 1; i <= 4; i++) d.pointerMove({ x: pick(), y: pick(), t: i * 0.016 });
      d.pointerUp({ x: pick(), y: pick(), t: 0.08 });
      // Случайное число кадров глайда до захвата.
      let ts = 0;
      const glideFrames = Math.floor(rnd() * 8);
      for (let i = 0; i < glideFrames && d.gliding; i++) {
        clock.pump(ts);
        ts += 16;
      }
      // Захват (иногда злой точкой) и release со случайной задержкой.
      d.pointerDown({ x: pick(), y: pick(), t: 1 });
      d.pointerUp({ x: pick(), y: pick(), t: 1 + rnd() * 0.3 });
      for (; ts <= 40_000 && d.gliding; ts += 16) clock.pump(ts);
      expect(d.gliding).toBe(false);
      expect(Number.isFinite(d.x)).toBe(true);
      expect(Number.isFinite(d.y)).toBe(true);
    }
  });
});
