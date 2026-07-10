/**
 * test/presence-impulse-continuity.test.ts
 * Классы: Б (characterization) + А (contract, вертикаль) + Д (mutation-proof).
 * Issue: #93 «единый C¹-контракт value+velocity», срез 5, строка матрицы
 * «exit → enter: обратное прерывание presence».
 *
 * Зачем: элемент в exit-анимации получает enter() (пользователь передумал).
 * До среза 5 машина при прерывании давала onEnterStart ТОЛЬКО `done`: канала
 * передать (value, velocity) exit-рана не существовало, и единственное
 * выразимое через API поведение — enter с нуля (телепорт в from и v0 = 0) —
 * разрыв C⁰/C¹ (характеризация: onEnterStart вызывался с arguments.length = 1).
 *
 * Контракт среза 5: колбэки фаз получают (done, interrupted, capture):
 *   — capture(read) регистрирует у ТЕКУЩЕЙ фазы функцию живого снимка
 *     (генерация-гард: регистратор прерванной фазы инертен);
 *   — при прерывании (enter во время exiting / exit во время entering) машина
 *     синхронно зовёт снимок и передаёт его новой фазе вторым аргументом —
 *     enter стартует спрингом с (value, velocity) exit-рана (reversed
 *     continuation через MotionValue.initialVelocity / drive.initialVelocity);
 *   — после доигранной фазы наследовать нечего: state-гард takeInterrupted
 *     делает чтение стейл-снимка недостижимым (явного гашения в done нет —
 *     мёртвый код, см. «Примечание минимальности» в src/presence/index.ts);
 *   — done/register фиксируют генерацию ДО transition: ре-энтрантный слушатель
 *     onStateChange не даёт зомби-фазе подменить живой снимок;
 *   — reduced-motion: CHARACTER-switch — фаз нет, снимок не течёт (без импульса).
 * Машина остаётся headless: снимок — непрозрачный S, никакой математики внутри.
 *
 * ── RED PROOF (вневременно — факты падений на базе среза 4, 10 RED / 1 green) ─
 * onEnterStart/onExitStart вызывались строго с одним аргументом (done):
 * все снимок-тесты падали «TypeError: capture is not a function» (третьего
 * аргумента не существовало; ❯ Object.exit src/presence/index.ts:136 —
 * options.onExitStart(done)); второй аргумент тоже отсутствовал (interrupted
 * недостижим). Единственный green на базе — «enter из gone → undefined»
 * (тривиален без канала). RED по правильной причине: отсутствие канала
 * переноса, не поломка машины.
 *
 * ── MUTATION PROOF (мутанты руками, каждый кусался, откачены; канонический
 *    список — в шапке src/presence/index.ts) ───────────────────────────────────
 *   [capture-loss]   при прерывании передавать undefined вместо capture() →
 *                    вертикаль и «двойное прерывание» RED (interrupted undefined).
 *   [reduced-leak]   читать снимок и в reduce-ветке (takeInterrupted до снапа) →
 *                    «reduce: …снимок НЕ читается» RED (reads=1 вместо 0).
 *   [stale-clear]    убрать безусловное гашение в takeInterrupted → «регистратор
 *                    прерванной фазы инертен» RED (стейл-снимок утёк).
 *   [state-guard]    снять `state === running` в takeInterrupted → «после
 *                    доигранной фазы снимок погашен» RED.
 *   [register-guard] снять gen-гард регистратора → «регистратор прерванной
 *                    фазы инертен» RED (стейл-регистрация подменила снимок).
 *   [register-late]  создать register ПОСЛЕ transition (ревью PR #128) →
 *                    «ре-энтрантность…» RED ('zombie-exit' вместо 'live-enter').
 *   [no-finally]     гасить capture без finally → «бросающий read…» RED
 *                    (ретрай exit() бросает повторно).
 */

import { describe, expect, it } from 'vitest';
import { createPresence, type PresenceSnapshot } from '../src/presence/index.js';
import { MotionValue } from '../src/index.js';
import { CompositorSpring, readCompositorSpring } from '../src/compositor/index.js';
import type { SpringParams } from '../src/spring.js';

const SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 24 };

/** Синхронные дренируемые часы (ts НЕ передаётся → FIXED_DT_S; handle ≠ 0). */
function makeClock() {
  const queue: Array<(ts?: number) => void> = [];
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return queue.length;
  };
  const step = (frames: number): void => {
    for (let i = 0; i < frames && queue.length > 0; i++) queue.shift()!();
  };
  return { requestFrame, step, queue };
}

/** matchMedia-стаб с переключаемым флагом reduce. */
function toggleMedia(initial: boolean) {
  const state = { reduce: initial };
  const mm = (() => ({ matches: state.reduce })) as unknown as (q: string) => MediaQueryList;
  return { state, mm };
}

// ─── Вертикаль: exit-ран (MotionValue) → прерывание → reversed enter ──────────

describe('presence: exit → enter наследует импульс (вертикаль #93, срез 5)', () => {
  it('вертикаль: enter наследует (value, velocity) живого exit-рана — C⁰ и C¹ на стыке', () => {
    const clock = makeClock();
    let exitMv: MotionValue | undefined;
    let enterMv: MotionValue | undefined;
    let inherited: PresenceSnapshot | undefined;
    const enterEmits: number[] = [];

    const p = createPresence({
      initiallyPresent: true,
      onExitStart: (_done, _interrupted, capture) => {
        // exit: opacity 1 → 0 живой пружиной.
        exitMv = new MotionValue({ initial: 1, spring: SPRING, requestFrame: clock.requestFrame });
        exitMv.setTarget(0);
        capture(() => ({ value: exitMv!.value, velocity: exitMv!.velocity }));
      },
      onEnterStart: (_done, interrupted) => {
        inherited = interrupted;
        // Reversed continuation: enter РОЖДАЕТСЯ в точке прерывания с его скоростью.
        exitMv!.destroy();
        enterMv = new MotionValue({
          initial: interrupted!.value,
          initialVelocity: interrupted!.velocity,
          spring: SPRING,
          clamp: false, // честный довыбег: импульс вниз коротко продавит ниже точки захвата
          requestFrame: clock.requestFrame,
        });
        enterMv.onChange((v) => enterEmits.push(v));
        enterMv.setTarget(1);
      },
    });

    p.exit();
    clock.step(6); // exit в полёте
    const valueAtGrab = exitMv!.value;
    const velocityAtGrab = exitMv!.velocity;
    expect(velocityAtGrab).toBeLessThan(-0.1); // ран действительно живой (едет к 0)

    p.enter(); // пользователь передумал
    expect(p.state).toBe('entering');
    expect(inherited).toBeDefined();
    expect(inherited!.value).toBe(valueAtGrab); // снимок снят В МОМЕНТ прерывания
    expect(inherited!.velocity).toBe(velocityAtGrab);
    expect(enterEmits[0]).toBe(valueAtGrab); // C⁰: рождение в точке прерывания
    expect(enterMv!.velocity).toBe(velocityAtGrab); // C¹: скорость унаследована

    // Физика reversed continuation: импульс вниз сначала продавливает значение
    // НИЖЕ точки захвата (короткий довыбег), потом пружина везёт к 1.
    clock.step(10);
    const early = Math.min(...enterEmits.slice(1));
    expect(early).toBeLessThan(valueAtGrab);
    clock.step(3000);
    expect(enterEmits[enterEmits.length - 1]).toBe(1); // осели на цели enter
    for (const v of enterEmits) expect(Number.isFinite(v)).toBe(true);
  });

  it('симметрия: exit во время entering получает снимок enter-рана', () => {
    const clock = makeClock();
    let enterMv: MotionValue | undefined;
    let inherited: PresenceSnapshot | undefined;
    const p = createPresence({
      onEnterStart: (_done, _interrupted, capture) => {
        enterMv = new MotionValue({ initial: 0, spring: SPRING, requestFrame: clock.requestFrame });
        enterMv.setTarget(1);
        capture(() => ({ value: enterMv!.value, velocity: enterMv!.velocity }));
      },
      onExitStart: (_done, interrupted) => {
        inherited = interrupted;
      },
    });
    p.enter();
    clock.step(6);
    const v = enterMv!.value;
    const vel = enterMv!.velocity;
    p.exit();
    expect(inherited).toBeDefined();
    expect(inherited!.value).toBe(v);
    expect(inherited!.velocity).toBe(vel);
  });

  it('вертикаль WAAPI: exit на compositor-пути читается аналитически (readCompositorSpring), без DOM', () => {
    // presence поверх ./compositor: exit-ран — CompositorSpring на фейк-элементе.
    let nowMs = 0;
    const animations: { cancelled: boolean; cancel(): void }[] = [];
    const el = {
      animate() {
        const a = { cancelled: false, cancel(): void { this.cancelled = true; } };
        animations.push(a);
        return a;
      },
    };
    let cs: CompositorSpring | undefined;
    let startMs = 0;
    let inherited: PresenceSnapshot | undefined;
    const p = createPresence({
      initiallyPresent: true,
      onExitStart: (_done, _interrupted, capture) => {
        cs = new CompositorSpring({
          spring: SPRING, property: 'opacity', from: 1, to: 0, target: el, now: () => nowMs,
        });
        startMs = nowMs;
        cs.start();
        // Живого чтения у WAAPI-рана нет — снимок замкнутой формой по elapsed.
        capture(() =>
          readCompositorSpring(SPRING, { from: 1, to: 0, t: (nowMs - startMs) / 1000 }),
        );
      },
      onEnterStart: (_done, interrupted) => {
        inherited = interrupted;
        cs!.stop(); // Animation отменяется — владение переходит enter-рану
      },
    });
    p.exit();
    expect(cs!.tier).toBe('compositor');
    nowMs = 120; // exit в полёте
    const expected = readCompositorSpring(SPRING, { from: 1, to: 0, t: 0.12 });
    p.enter();
    expect(inherited).toBeDefined();
    expect(inherited!.value).toBe(expected.value);
    expect(inherited!.velocity).toBe(expected.velocity);
    expect(inherited!.velocity).toBeLessThan(0); // живая скорость к 0, не телепорт
    expect(animations[0]!.cancelled).toBe(true); // второго драйвера нет
  });
});

// ─── Жизненный цикл снимка ─────────────────────────────────────────────────────

describe('presence impulse: жизненный цикл снимка (класс А/Д)', () => {
  it('характеризация базы снята: interrupted приходит ВТОРЫМ аргументом при прерывании', () => {
    const seen: unknown[] = [];
    const p = createPresence<number>({
      initiallyPresent: true,
      onExitStart: (_done, _interrupted, capture) => capture(() => 42),
      onEnterStart: (_done, interrupted) => {
        seen.push(interrupted);
      },
    });
    p.exit(); // живой exit-ран с зарегистрированным снимком
    p.enter(); // прерывание: до среза 5 onEnterStart звался с одним аргументом
    expect(seen[0]).toBeDefined();
    expect(seen).toEqual([42]);
  });

  it('enter из gone (нечего прерывать) → interrupted === undefined', () => {
    const seen: unknown[] = [];
    const p = createPresence({
      onEnterStart: (_done, interrupted) => {
        seen.push(interrupted);
      },
    });
    p.enter();
    expect(seen).toEqual([undefined]);
  });

  it('после доигранной фазы снимок погашен: exit после done(enter) получает undefined', () => {
    const seen: unknown[] = [];
    const dones: Array<() => void> = [];
    const p = createPresence<number>({
      onEnterStart: (done, _i, capture) => {
        dones.push(done);
        capture(() => 7);
      },
      onExitStart: (_done, interrupted) => {
        seen.push(interrupted);
      },
    });
    p.enter();
    dones[0]!(); // enter доигран → present; снимок обязан погаснуть
    p.exit();
    expect(seen).toEqual([undefined]);
  });

  it('двойное прерывание enter→exit→enter: второй enter получает снимок EXIT-рана (свежайший)', () => {
    const enterSeen: unknown[] = [];
    const exitSeen: unknown[] = [];
    const p = createPresence<string>({
      onEnterStart: (_done, interrupted, capture) => {
        enterSeen.push(interrupted);
        capture(() => 'enter-run');
      },
      onExitStart: (_done, interrupted, capture) => {
        exitSeen.push(interrupted);
        capture(() => 'exit-run');
      },
    });
    p.enter(); // из gone
    p.exit(); // прерывает enter
    p.enter(); // прерывает exit
    expect(enterSeen).toEqual([undefined, 'exit-run']);
    expect(exitSeen).toEqual(['enter-run']);
  });

  it('регистратор прерванной фазы инертен (генерация-гард): стейл-capture не подменяет снимок', () => {
    let staleRegister: ((read: () => string) => void) | undefined;
    let first = true;
    const enterSeen: unknown[] = [];
    const exitSeen: unknown[] = [];
    const p = createPresence<string>({
      onEnterStart: (_done, interrupted, capture) => {
        enterSeen.push(interrupted);
        if (first) {
          first = false;
          staleRegister = capture;
          capture(() => 'live-enter');
        }
      },
      onExitStart: (_done, interrupted) => {
        exitSeen.push(interrupted);
      },
    });
    p.enter(); // регистрирует 'live-enter', регистратор сохранён
    p.exit(); // прерывает enter → снимок 'live-enter'
    staleRegister!(() => 'stale-write'); // регистратор ПРЕРВАННОЙ фазы — обязан быть инертен
    p.enter(); // прерывает exit; exit ничего не регистрировал → undefined, НЕ 'stale-write'
    expect(enterSeen).toEqual([undefined, undefined]);
    expect(exitSeen).toEqual(['live-enter']);
  });

  it('снимок снят синхронно В МОМЕНТ прерывания, ровно один раз', () => {
    let reads = 0;
    let current = 10;
    const seen: unknown[] = [];
    const p = createPresence<number>({
      initiallyPresent: true,
      onExitStart: (_done, _i, capture) =>
        capture(() => {
          reads++;
          return current;
        }),
      onEnterStart: (_done, interrupted) => {
        seen.push(interrupted);
      },
    });
    p.exit();
    current = 55; // «ран» доехал сюда к моменту прерывания
    p.enter();
    current = 99; // после прерывания снимок меняться не должен
    expect(reads).toBe(1);
    expect(seen).toEqual([55]);
  });
});

// ─── Reduced motion: CHARACTER-switch без импульса ────────────────────────────

describe('presence impulse: prefers-reduced-motion (без импульса)', () => {
  it('reduce: enter во время exiting мгновенен, снимок НЕ читается (нет фазы — нет импульса)', () => {
    const { state, mm } = toggleMedia(false);
    let reads = 0;
    const p = createPresence<number>({
      initiallyPresent: true,
      matchMedia: mm,
      onExitStart: (_done, _i, capture) =>
        capture(() => {
          reads++;
          return 1;
        }),
    });
    p.exit(); // обычный exit-ран (reduce ещё выключен)
    state.reduce = true; // предпочтение включилось до enter
    p.enter();
    expect(p.state).toBe('present'); // мгновенно, без анимационной фазы
    expect(reads).toBe(0); // снимок не читался — импульс не переносится
  });

  it('reduce: снимок не переживает reduce-переход — следующая не-reduce фаза получает undefined', () => {
    const { state, mm } = toggleMedia(false);
    const exitSeen: unknown[] = [];
    const p = createPresence<number>({
      initiallyPresent: true,
      matchMedia: mm,
      onExitStart: (_done, interrupted, capture) => {
        exitSeen.push(interrupted);
        capture(() => 5);
      },
    });
    p.exit(); // ран с зарегистрированным снимком
    state.reduce = true;
    p.enter(); // мгновенный present; стейл-снимок exit-рана обязан погаснуть
    state.reduce = false;
    p.exit(); // обычная фаза: прерывать нечего
    expect(exitSeen).toEqual([undefined, undefined]);
  });
});

// ─── Adversarial-находки ревью PR #128 ────────────────────────────────────────

describe('presence: ре-энтрантность и бросающий read (ревью PR #128)', () => {
  it('ре-энтрантность onStateChange: регистратор зомби-фазы инертен, живой снимок цел', () => {
    // Находка major: до фикса done/register создавались ПОСЛЕ transition —
    // слушатель, синхронно зовущий enter() при 'exiting', бампал generation,
    // и регистратор зомби-exit снимал ЧУЖУЮ (живую) генерацию: capture зомби
    // перезаписывал живой enter-снимок, следующий exit() получал 'zombie-exit'.
    // RED-факт до фикса: expected 'zombie-exit' to be 'live-enter'.
    const exitFroms: Array<string | undefined> = [];
    let reentered = false;
    const p = createPresence<string>({
      onEnterStart: (_done, _from, capture) => {
        capture(() => 'live-enter');
      },
      onExitStart: (_done, from, capture) => {
        exitFroms.push(from);
        capture(() => 'zombie-exit');
      },
    });
    p.enter(); // живой enter-ран с зарегистрированным снимком
    p.onStateChange((s) => {
      if (s === 'exiting' && !reentered) {
        reentered = true;
        p.enter(); // пользователь передумал синхронно в слушателе
      }
    });
    p.exit(); // прерван ре-энтрантно ИЗ transition('exiting')
    expect(p.state).toBe('entering'); // живой — enter из слушателя
    p.exit(); // прерываем живой enter: снимок обязан быть его, не зомби-exit'а
    expect(exitFroms.at(-1)).toBe('live-enter');
  });

  it('бросающий read: capture гасится (finally), ретрай перехода не бросает повторно', () => {
    // Находка minor: без finally бросок из read оставлял машину полу-мёртвой —
    // state не сменился, capture не погашен, каждый следующий exit() бросал
    // снова. RED-факт до фикса: второй p.exit() бросал 'boom' повторно.
    const p = createPresence<number>({
      onEnterStart: (_done, _from, capture) => {
        capture(() => {
          throw new Error('boom');
        });
      },
      onExitStart: () => {},
    });
    p.enter();
    expect(() => p.exit()).toThrow('boom'); // первый бросок честно пропагируется
    expect(p.state).toBe('entering'); // переход не состоялся (бросок до transition)
    expect(() => p.exit()).not.toThrow(); // снимок погашен — ретрай работает
    expect(p.state).toBe('exiting');
  });
});
