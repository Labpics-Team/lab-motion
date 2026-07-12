// @vitest-environment jsdom
/**
 * test/react-runtime.test.ts — S35: интеграция react-биндинга в РЕАЛЬНОМ рантайме.
 *
 * Прежде react-биндинг проверялся только через MotionValue + инжектированный
 * клок (unit). Здесь — настоящий React 18 (createRoot + act + jsdom): реальные
 * хуки useState/useEffect/useRef, реальный ре-рендер по onChange, реальный
 * teardown по unmount. Закрывает класс «хук-склейка сломана в живом React»
 * (правила хуков, реактивность setState, cleanup-эффект), который моки не видят.
 *
 * Клок инжектируется → детерминизм (инвариант движка) сохранён в live-рантайме.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState, StrictMode, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSpring, useMotionValue, useMotionStyle, useReducedMotion } from '../src/react/index.js';
import { MotionValue } from '../src/motion-value.js';

// React 18 требует этот флаг для act() вне test-renderer.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

/** Инжектируемая rAF-очередь: контролируем кадры вручную (детерминизм). */
function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  return {
    requestFrame: (cb: (ts?: number) => void): number => { q.push(cb); return 1; },
    drain(maxFrames = 2000): void {
      let n = 0;
      while (q.length > 0 && n++ < maxFrames) {
        const cb = q.shift()!;
        cb();
      }
    },
    pending: () => q.length,
  };
}

let mounted: Array<{ root: Root; container: HTMLElement }> = [];
function mount(el: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  mounted.push({ root, container });
  return container;
}
afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
});

describe('react-биндинг в реальном React-рантайме', () => {
  it('useSpring: живой ре-рендер обновляет DOM при setTarget через клок', () => {
    const clock = makeClock();
    let setTarget!: Dispatch<SetStateAction<number>>;
    function Box(): ReturnType<typeof createElement> {
      const [t, setT] = useState(0);
      setTarget = setT;
      const x = useSpring(t, SPRING, 'instant', clock.requestFrame);
      return createElement('div', { id: 'box' }, x.toFixed(2));
    }
    const c = mount(createElement(Box));
    const box = () => c.querySelector('#box')!.textContent!;

    expect(Number(box())).toBe(0); // первый рендер: старт на target

    act(() => setTarget(100)); // меняем цель → пружина стартует
    act(() => clock.drain()); // прогоняем кадры (onChange→setState в act)

    const v = Number(box());
    expect(v).toBeGreaterThan(0); // реально анимировалось к 100
    expect(v).toBeLessThanOrEqual(100);
    expect(Number.isFinite(v)).toBe(true); // CSS-safe в живом DOM
  });

  it('useSpring settled: значение сходится к цели после полного прогона', () => {
    const clock = makeClock();
    let setTarget!: Dispatch<SetStateAction<number>>;
    function Box(): ReturnType<typeof createElement> {
      const [t, setT] = useState(0);
      setTarget = setT;
      const x = useSpring(t, SPRING, 'instant', clock.requestFrame);
      return createElement('div', { id: 'box' }, x.toFixed(4));
    }
    const c = mount(createElement(Box));
    act(() => setTarget(50));
    act(() => clock.drain());
    expect(Number(c.querySelector('#box')!.textContent)).toBeCloseTo(50, 1);
  });

  it('useSpring: full→reduce инвалидирует уже поставленный кадр', () => {
    const w = window as unknown as { matchMedia?: (q: string) => MediaQueryList };
    const previous = w.matchMedia;
    let reduced = false;
    w.matchMedia = (query: string) => ({ matches: reduced, media: query } as MediaQueryList);

    try {
      const clock = makeClock();
      let setTarget!: Dispatch<SetStateAction<number>>;
      function Box(): ReturnType<typeof createElement> {
        const [target, setT] = useState(0);
        setTarget = setT;
        const value = useSpring(target, SPRING, 'instant', clock.requestFrame);
        return createElement('div', { id: 'box' }, value);
      }

      const c = mount(createElement(Box));
      act(() => setTarget(100));
      expect(clock.pending()).toBeGreaterThan(0);

      reduced = true;
      act(() => setTarget(200));
      expect(Number(c.querySelector('#box')!.textContent)).toBe(200);

      act(() => clock.drain());
      expect(Number(c.querySelector('#box')!.textContent)).toBe(200);
    } finally {
      w.matchMedia = previous;
    }
  });

  it('unmount вызывает destroy: цикл MotionValue остановлен, эмиссий после нет', () => {
    // Сильный оракул (нота QA): не «не бросает», а ПРЯМОЕ негативное покрытие
    // класса «утечка ресурса» — свой onChange-счётчик на инстансе; после unmount
    // destroy() очищает listeners и глушит цикл → повторный setTarget+прогон НЕ
    // даёт новых эмиссий. Диверсия «убрать destroy» → листенер жив, цикл гоняет
    // → эмиссии есть → тест краснеет.
    const clock = makeClock();
    let mv!: ReturnType<typeof useMotionValue>;
    function Box(): ReturnType<typeof createElement> {
      mv = useMotionValue(0, SPRING, clock.requestFrame);
      return createElement('div', { id: 'box' }, 'x');
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Box)));

    let emits = 0;
    const off = mv.onChange(() => { emits += 1; }); // immediate-emit → emits=1
    act(() => { mv.setTarget(100); clock.drain(); }); // живая анимация
    const before = emits;
    expect(before).toBeGreaterThan(1); // эмиссии реально шли

    act(() => root.unmount()); // teardown → cleanup-эффект → mv.destroy()

    act(() => { mv.setTarget(0); clock.drain(); }); // проба: жив ли цикл?
    expect(emits).toBe(before); // destroy погасил — ноль новых эмиссий к листенеру
    expect(() => act(() => clock.drain())).not.toThrow(); // и не бросает
    off();
    container.remove();
  });

  it('useMotionValue: стабильный инстанс между рендерами (useRef-кэш)', () => {
    const clock = makeClock();
    let force!: Dispatch<SetStateAction<number>>;
    const instances: unknown[] = [];
    function Box(): ReturnType<typeof createElement> {
      const [, setN] = useState(0);
      force = setN;
      const mv = useMotionValue(0, SPRING, clock.requestFrame);
      instances.push(mv);
      return createElement('div', null, 'x');
    }
    mount(createElement(Box));
    act(() => force((n) => n + 1)); // ре-рендер
    act(() => force((n) => n + 1));
    // MotionValue создаётся ОДИН раз и переживает ре-рендеры (не пересоздаётся).
    expect(instances.length).toBeGreaterThanOrEqual(3);
    expect(instances.every((i) => i === instances[0])).toBe(true);
  });

  it('StrictMode replay сохраняет useMotionValue живым до реального unmount', () => {
    const clock = makeClock();
    let mv!: ReturnType<typeof useMotionValue>;
    function Probe(): ReturnType<typeof createElement> {
      mv = useMotionValue(0, SPRING, clock.requestFrame);
      return createElement('div', null, 'probe');
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let unmounted = false;
    try {
      act(() => root.render(createElement(StrictMode, null, createElement(Probe))));

      mv.setTarget(100);
      expect(clock.pending()).toBeGreaterThan(0);
      clock.drain();
      expect(mv.value).toBeCloseTo(100, 1);

      act(() => root.unmount());
      unmounted = true;
      const settled = mv.value;
      mv.setTarget(0);
      clock.drain();
      expect(mv.value).toBe(settled);
    } finally {
      if (!unmounted) act(() => root.unmount());
      container.remove();
    }
  });

  it('StrictMode useSpring после replay планирует полёт и держит одну подписку', () => {
    const originalOnChange = MotionValue.prototype.onChange;
    let activeSubscriptions = 0;
    let maxActiveSubscriptions = 0;
    const onChangeSpy = vi
      .spyOn(MotionValue.prototype, 'onChange')
      .mockImplementation(function (this: MotionValue, cb: (value: number) => void) {
        const off = originalOnChange.call(this, cb);
        activeSubscriptions += 1;
        maxActiveSubscriptions = Math.max(maxActiveSubscriptions, activeSubscriptions);
        let closed = false;
        return () => {
          if (closed) return;
          closed = true;
          activeSubscriptions -= 1;
          off();
        };
      });

    const clock = makeClock();
    let setTarget!: Dispatch<SetStateAction<number>>;
    function Box(): ReturnType<typeof createElement> {
      const [target, setT] = useState(0);
      setTarget = setT;
      const value = useSpring(target, SPRING, 'instant', clock.requestFrame);
      return createElement('div', { id: 'strict-spring' }, value);
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let unmounted = false;
    try {
      act(() => root.render(createElement(StrictMode, null, createElement(Box))));
      expect(activeSubscriptions).toBe(1);
      expect(maxActiveSubscriptions).toBe(1);

      act(() => setTarget(100));
      expect(clock.pending()).toBeGreaterThan(0);
      expect(Number(container.querySelector('#strict-spring')!.textContent)).toBeLessThan(100);

      act(() => clock.drain());
      expect(Number(container.querySelector('#strict-spring')!.textContent)).toBeCloseTo(100, 1);
      expect(activeSubscriptions).toBe(1);
      expect(maxActiveSubscriptions).toBe(1);

      act(() => root.unmount());
      unmounted = true;
      expect(activeSubscriptions).toBe(0);
    } finally {
      if (!unmounted) act(() => root.unmount());
      container.remove();
      onChangeSpy.mockRestore();
    }
  });
});

describe('useMotionStyle — effect binding без render на кадр (#104)', () => {
  it('анимирует style.transform в DOM, но НЕ ре-рендерит компонент на кадр', () => {
    // Ядро контракта #104: effect-binding пишет в DOM через ref/onChange, а не
    // через setState. Диверсия «заменить прямую запись в style на setState» →
    // renders растёт по кадрам → тест краснеет. useSpring (render value) сознательно
    // рендерит на кадр; useMotionStyle — нет.
    const clock = makeClock();
    let renders = 0;
    let setOpen!: Dispatch<SetStateAction<boolean>>;
    function Box(): ReturnType<typeof createElement> {
      renders += 1;
      const [open, setO] = useState(false);
      setOpen = setO;
      const ref = useMotionStyle({
        target: open ? 200 : 0,
        property: 'transform',
        template: 'translateX({v}px)',
        from: 0,
        spring: SPRING,
        requestFrame: clock.requestFrame,
      });
      return createElement('div', { id: 'box', ref });
    }
    const c = mount(createElement(Box));
    const box = (): HTMLElement => c.querySelector('#box') as HTMLElement;

    expect(renders).toBe(1); // только первичный render
    expect(box().style.transform).toBe('translateX(0px)'); // initial (from=0) записан

    act(() => setOpen(true)); // смена цели родителем → РОВНО один доп. render
    expect(renders).toBe(2);

    act(() => clock.drain()); // прогон кадров анимации
    expect(renders).toBe(2); // ← НИ ОДНОГО render на кадр (записи шли прямо в style)

    const m = /translateX\(([-\d.]+)px\)/.exec(box().style.transform);
    const x = Number(m![1]);
    expect(x).toBeGreaterThan(0); // DOM реально анимировался к 200
    expect(x).toBeLessThanOrEqual(200);
    expect(Number.isFinite(x)).toBe(true); // CSS-safe
  });

  it('оседает точно на цель после полного прогона', () => {
    const clock = makeClock();
    let setOpen!: Dispatch<SetStateAction<boolean>>;
    function Box(): ReturnType<typeof createElement> {
      const [open, setO] = useState(false);
      setOpen = setO;
      const ref = useMotionStyle({
        target: open ? 100 : 0,
        property: 'opacity',
        from: 0,
        spring: SPRING,
        requestFrame: clock.requestFrame,
      });
      return createElement('div', { id: 'box', ref });
    }
    const c = mount(createElement(Box));
    act(() => setOpen(true));
    act(() => clock.drain());
    expect(Number((c.querySelector('#box') as HTMLElement).style.opacity)).toBeCloseTo(100, 1);
  });

  it('перепроецирует settled value при смене property/template без нового кадра', () => {
    const clock = makeClock();
    let setProjection!: Dispatch<
      SetStateAction<{ property: string; template: string }>
    >;
    function Box(): ReturnType<typeof createElement> {
      const [projection, setP] = useState({ property: 'opacity', template: '{v}' });
      setProjection = setP;
      const ref = useMotionStyle({
        target: 0,
        from: 0,
        ...projection,
        spring: SPRING,
        requestFrame: clock.requestFrame,
      });
      return createElement('div', { id: 'box', ref });
    }
    const c = mount(createElement(Box));
    const box = c.querySelector('#box') as HTMLElement;
    expect(box.style.opacity).toBe('0');

    act(() => setProjection({ property: 'transform', template: 'translate({v}px, {v}px)' }));

    expect(box.style.opacity).toBe('');
    expect(box.style.transform).toBe('translate(0px, 0px)');
    expect(clock.pending()).toBe(0);
  });

  it('reduced-motion: CHARACTER-снап без единого кадра (rAF не планируется)', () => {
    // northInvariant #5: reduced меняет ХАРАКТЕР (мгновенный снап), не hard-off.
    const w = window as unknown as { matchMedia?: (q: string) => { matches: boolean } };
    const prev = w.matchMedia;
    w.matchMedia = (q: string) => ({ matches: true, media: q } as MediaQueryList);
    try {
      const clock = makeClock();
      let setOpen!: Dispatch<SetStateAction<boolean>>;
      function Box(): ReturnType<typeof createElement> {
        const [open, setO] = useState(false);
        setOpen = setO;
        const ref = useMotionStyle({
          target: open ? 300 : 0,
          property: 'transform',
          template: 'translateX({v}px)',
          from: 0,
          spring: SPRING,
          requestFrame: clock.requestFrame,
        });
        return createElement('div', { id: 'box', ref });
      }
      const c = mount(createElement(Box));
      act(() => setOpen(true));
      // Снап сразу на цель, без запланированных кадров.
      expect((c.querySelector('#box') as HTMLElement).style.transform).toBe('translateX(300px)');
      expect(clock.pending()).toBe(0);
    } finally {
      w.matchMedia = prev;
    }
  });

  it('unmount: destroy гасит цикл — после размонтирования style не меняется и нет throw', () => {
    const clock = makeClock();
    function Box(): ReturnType<typeof createElement> {
      const ref = useMotionStyle({
        target: 200,
        property: 'transform',
        template: 'translateX({v}px)',
        from: 0,
        spring: SPRING,
        requestFrame: clock.requestFrame,
      });
      return createElement('div', { id: 'box', ref });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Box)));
    act(() => clock.drain()); // анимация шла
    const box = container.querySelector('#box') as HTMLElement;
    const settled = box.style.transform;

    act(() => root.unmount()); // teardown → cleanup-эффект → unsub + destroy
    // Цикл погашен: повторный прогон часов ничего не пишет и не бросает.
    expect(() => act(() => clock.drain())).not.toThrow();
    expect(box.style.transform).toBe(settled); // без изменений после unmount
  });

  it('reduced-снап через snapTo синхронизирует MotionValue — не-reduced retarget не прыгает от stale', () => {
    // Регрессия (adversarial/CodeRabbit): reduced-ветка обязана звать snapTo, а не
    // голую запись в style. snapTo гасит живой ран и ресинхронит value/velocity,
    // поэтому следующий НЕ-reduced retarget стартует пружину от снапнутого значения,
    // а не от stale _value. Диверсия «write(target) вместо snapTo(target)» → MV.value
    // остаётся stale (0) → пружина прыгает к ~0 первым кадром → тест краснеет.
    const w = window as unknown as { matchMedia?: (q: string) => { matches: boolean } };
    const prev = w.matchMedia;
    const mm = { matches: true };
    w.matchMedia = (q: string) => ({ matches: mm.matches, media: q } as MediaQueryList);
    try {
      const clock = makeClock();
      let setPos!: Dispatch<SetStateAction<number>>;
      function Box(): ReturnType<typeof createElement> {
        const [pos, setP] = useState(0);
        setPos = setP;
        const ref = useMotionStyle({
          target: pos,
          property: 'transform',
          template: 'translateX({v}px)',
          from: 0,
          spring: SPRING,
          requestFrame: clock.requestFrame,
        });
        return createElement('div', { id: 'box', ref });
      }
      const c = mount(createElement(Box));
      const xOf = (): number =>
        Number(
          /translateX\(([-\d.]+)px\)/.exec((c.querySelector('#box') as HTMLElement).style.transform)![1],
        );

      // reduced ON: снап на 300 (DOM + MV синхронны через snapTo).
      act(() => setPos(300));
      expect(xOf()).toBe(300);

      // reduced OFF: retarget на 350 → пружина обязана стартовать от 300, не от stale 0.
      mm.matches = false;
      act(() => setPos(350));
      act(() => clock.drain(1)); // один кадр
      expect(xOf()).toBeGreaterThan(280); // с багом было бы ~0 (старт от stale)
      act(() => clock.drain());
      expect(xOf()).toBeCloseTo(350, 0); // и оседает на новую цель
    } finally {
      w.matchMedia = prev;
    }
  });

  it('поздний/условный attach элемента применяет текущее значение (from) сразу', () => {
    // Регрессия (adversarial): при `{shown && <div ref={ref}/>}` элемент монтируется
    // ПОСЛЕ layout-эффекта, чей начальный write ушёл в null. ref-callback обязан
    // записать текущее значение на attach, иначе элемент появляется без стиля (без
    // from) до первого retarget/кадра. Диверсия «ref-callback только пишет elRef» →
    // opacity пустой после появления → тест краснеет.
    const clock = makeClock();
    let setShown!: Dispatch<SetStateAction<boolean>>;
    function Box(): ReturnType<typeof createElement> {
      const [shown, setS] = useState(false);
      setShown = setS;
      const ref = useMotionStyle({
        target: 0.42,
        property: 'opacity',
        from: 0.42, // статично (target==from): нет анимации, проверяем именно attach-write
        spring: SPRING,
        requestFrame: clock.requestFrame,
      });
      return shown ? createElement('div', { id: 'box', ref }) : null;
    }
    const c = mount(createElement(Box));
    expect(c.querySelector('#box')).toBeNull(); // ещё не смонтирован

    act(() => setShown(true)); // элемент появляется сейчас
    const box = c.querySelector('#box') as HTMLElement;
    expect(Number(box.style.opacity)).toBeCloseTo(0.42, 5); // from применён на attach
  });

  it('StrictMode mount→cleanup→remount: без краша, один цикл, анимация работает', () => {
    // #104 инвариант: StrictMode гоняет setup→cleanup→setup БЕЗ ре-рендера.
    // cleanup рушит+нулит MotionValue, поэтому второй setup обязан пересоздать его,
    // иначе разыменование уничтоженного значения бросает TypeError (RED до фикса:
    // прямое `mvRef.current!` после null → краш на remount). Один живой цикл:
    // прошлый MV уничтожается до создания нового, двойной скорости нет.
    const clock = makeClock();
    let setOpen!: Dispatch<SetStateAction<boolean>>;
    function Box(): ReturnType<typeof createElement> {
      const [open, setO] = useState(false);
      setOpen = setO;
      const ref = useMotionStyle({
        target: open ? 100 : 0,
        property: 'opacity',
        from: 0,
        spring: SPRING,
        requestFrame: clock.requestFrame,
      });
      return createElement('div', { id: 'box', ref });
    }
    // Монтирование под StrictMode не должно бросать (двойной setup эффектов).
    let c!: HTMLElement;
    expect(() => {
      c = mount(createElement(StrictMode, null, createElement(Box)));
    }).not.toThrow();

    act(() => setOpen(true));
    act(() => clock.drain());
    // Анимация корректна после StrictMode-ремоунта (живой единственный цикл).
    expect(Number((c.querySelector('#box') as HTMLElement).style.opacity)).toBeCloseTo(100, 1);
  });
});

// ─── useReducedMotion (#104 срез 2) ────────────────────────────────────────

/**
 * Управляемый matchMedia-шов: MediaQueryList с живым `matches` (геттер) и общим
 * реестром слушателей; `set(v)` флипает предпочтение и будит слушателей (как
 * системный 'change'). Инжектируется в хук — детерминизм без реального OS-события.
 */
function makeFakeMedia(initial = false): {
  matchMedia: (q: string) => MediaQueryList;
  set(v: boolean): void;
  listenerCount(): number;
} {
  let matches = initial;
  const listeners = new Set<() => void>();
  const matchMedia = (q: string): MediaQueryList =>
    ({
      get matches() {
        return matches;
      },
      media: q,
      onchange: null,
      addEventListener: (_e: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_e: string, cb: () => void) => listeners.delete(cb),
      addListener: (cb: () => void) => listeners.add(cb),
      removeListener: (cb: () => void) => listeners.delete(cb),
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList;
  return {
    matchMedia,
    set(v: boolean): void {
      matches = v;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.size,
  };
}

describe('useReducedMotion — реактивное системное предпочтение (#104)', () => {
  it('реактивно отражает смену prefers-reduced-motion (change → re-render)', () => {
    // Ядро: смена системного предпочтения обязана перерендерить и вернуть новый
    // boolean. Диверсия «getSnapshot всегда false» ИЛИ «subscribe = no-op» →
    // значение не меняется после set(true) → тест краснеет.
    const fake = makeFakeMedia(false);
    function Probe(): ReturnType<typeof createElement> {
      const reduced = useReducedMotion(fake.matchMedia);
      return createElement('div', { id: 'p' }, String(reduced));
    }
    const c = mount(createElement(Probe));
    const txt = (): string => (c.querySelector('#p') as HTMLElement).textContent!;

    expect(txt()).toBe('false'); // начальное (matches=false, клиентский снапшот)
    act(() => fake.set(true)); // система включила reduce
    expect(txt()).toBe('true'); // реактивно обновилось
    act(() => fake.set(false)); // и обратно
    expect(txt()).toBe('false');
  });

  it('начальное значение читается из matchMedia синхронно (matches=true → true)', () => {
    const fake = makeFakeMedia(true);
    function Probe(): ReturnType<typeof createElement> {
      return createElement('div', { id: 'p' }, String(useReducedMotion(fake.matchMedia)));
    }
    const c = mount(createElement(Probe));
    expect((c.querySelector('#p') as HTMLElement).textContent).toBe('true');
  });

  it('SSR/без matchMedia → false и не бросает', () => {
    function Probe(): ReturnType<typeof createElement> {
      // Явно undefined-шов: имитируем окружение без matchMedia.
      return createElement('div', { id: 'p' }, String(useReducedMotion(undefined)));
    }
    // window.matchMedia в jsdom отсутствует → _resolveMatchMedia вернёт undefined.
    let c!: HTMLElement;
    expect(() => {
      c = mount(createElement(Probe));
    }).not.toThrow();
    expect((c.querySelector('#p') as HTMLElement).textContent).toBe('false');
  });

  it('unmount снимает системного слушателя (нет утечки)', () => {
    const fake = makeFakeMedia(false);
    function Probe(): ReturnType<typeof createElement> {
      useReducedMotion(fake.matchMedia);
      return createElement('div', null, 'x');
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Probe)));
    expect(fake.listenerCount()).toBeGreaterThan(0); // подписан
    act(() => root.unmount());
    expect(fake.listenerCount()).toBe(0); // destroy() снял слушателя
    container.remove();
  });
});
