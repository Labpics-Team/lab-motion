/**
 * test/qwik.test.ts — Qwik-биндинг (subpath ./qwik, S19).
 * Классы: А (жизненный цикл/анимация через сигнал-цель) + В (reduced-характер,
 * NaN-гард, резюм-пересоздание, unmount-гейт) + Д.
 *
 * ── RED-PROOF ЧЕРЕЗ MUTATION ─────────────────────────────────────────────────
 * Реализация писалась параллельно тестам — зубастость каждого блока
 * доказывается mutation-прогоном координатора (init-один-раз, track-драйвер,
 * reduced-снап, NaN-гард, unmount-гейт, cleanup-размещение).
 *
 * @builder.io/qwik мокается минимально-честно: useSignal → {value};
 * useVisibleTask$ регистрирует таски, track собирает геттер, cleanup копится;
 * re-run драйвер-таски эмулируется явным fireTasks() (в браузере это делает
 * Qwik по track-подписке); noSerialize → identity (сериализацию резюма
 * эмулирует тест «резюм» обнулением mvRef вручную).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

function makeVirtualClock(dtMs = 1000 / 60) {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  let handle = 0;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return ++handle;
    },
    drainAll(max = 3000): void {
      let i = 0;
      while (queue.length > 0 && i++ < max) {
        const cb = queue.shift()!;
        clock += dtMs;
        cb(clock);
      }
    },
  };
}

// ─── Мок @builder.io/qwik ────────────────────────────────────────────────────

type Task = {
  fn: (ctx: {
    track: <T>(g: () => T) => T;
    cleanup: (cb: () => void) => void;
  }) => void;
  cleanups: Array<() => void>;
  tracked: boolean;
};

let tasks: Task[] = [];

vi.mock('@builder.io/qwik', () => ({
  useSignal: (initial: unknown) => ({ value: initial }),
  noSerialize: (v: unknown) => v,
  useVisibleTask$: (fn: Task['fn']) => {
    const task: Task = { fn, cleanups: [], tracked: false };
    tasks.push(task);
    runTask(task); // Qwik исполняет visible-таску после маунта
  },
}));

function runTask(task: Task): void {
  // re-run: сначала cleanups предыдущего запуска (семантика Qwik)
  for (const c of task.cleanups) c();
  task.cleanups = [];
  task.fn({
    track: (g) => {
      task.tracked = true;
      return g();
    },
    cleanup: (cb) => {
      task.cleanups.push(cb);
    },
  });
}

/** Эмуляция реакции Qwik на смену затреканного сигнала. */
function fireTrackedTasks(): void {
  for (const task of tasks) if (task.tracked) runTask(task);
}

/** Unmount: cleanups всех тасок. */
function unmountAll(): void {
  for (const task of tasks) {
    for (const c of task.cleanups) c();
    task.cleanups = [];
  }
  tasks = [];
}

beforeEach(() => {
  tasks = [];
});

afterEach(() => {
  unmountAll();
  delete (globalThis as { window?: unknown }).window;
});

const SPRING = { mass: 1, stiffness: 200, damping: 26 };

describe('qwik: useSpring — управление через сигнал-цель', () => {
  it('присваивание target.value анимирует до цели по кадрам', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    expect(s.value.value).toBe(0);
    s.target.value = 100;
    fireTrackedTasks();
    vc.drainAll();
    expect(Math.abs(s.value.value - 100)).toBeLessThan(0.5);
  });

  it('full-motion: значение проходит через полёт (не мгновенный снап)', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    s.target.value = 100;
    fireTrackedTasks();
    vc.drainAll(5);
    expect(s.value.value).toBeGreaterThan(0);
    expect(s.value.value).toBeLessThan(99);
  });

  it('резюм: MotionValue пересоздаётся на клиенте, анимация продолжает работать', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    // «Сервер» отдал value/target=42, mv не существует (noSerialize → undefined
    // после резюма). Эмулируем: хук вызывается заново с initial=42, таски
    // исполняются как при первом visible.
    const s = useSpring(42, SPRING, 'instant', vc.requestFrame);
    expect(s.value.value).toBe(42);
    s.target.value = 0;
    fireTrackedTasks();
    vc.drainAll();
    expect(Math.abs(s.value.value - 0)).toBeLessThan(0.5);
  });

  it('unmount: destroy вызван, дальнейшие смены цели не двигают значение', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    unmountAll();
    s.target.value = 100;
    // тасок больше нет — но даже прямой прогон драйвера обязан гейтиться
    vc.drainAll();
    expect(s.value.value).toBe(0);
  });

  it('гонка: драйвер-таска после unmount не бросает и не пишет (unmount-гейт)', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    const driver = tasks.find((t) => t.tracked)!; // адресно, не позиционно
    unmountAll();
    s.target.value = 100;
    expect(() => runTask(driver)).not.toThrow(); // без гейта — TypeError на undefined.setTarget
    vc.drainAll();
    expect(s.value.value).toBe(0);
  });

  it('reduced: запись после unmount гейтится обнулённым ref (не загрязняет сигнал)', async () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(7, SPRING, 'instant', vc.requestFrame);
    const driver = tasks.find((t) => t.tracked)!;
    unmountAll(); // cleanup обязан обнулить mvRef — иначе reduced-ветка запишет
    s.target.value = 50;
    runTask(driver);
    expect(s.value.value).toBe(7);
  });

  it('reduced-motion: снап синхронно; NaN → MotionParamError, сигнал чист', async () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    s.target.value = 100;
    fireTrackedTasks();
    expect(s.value.value).toBe(100); // без кадров
    s.target.value = NaN;
    expect(() => fireTrackedTasks()).toThrow();
    expect(s.value.value).toBe(100); // не загрязнён
  });

  it('идемпотентность драйвера: повтор той же цели в reduced не пишет в сигнал повторно', async () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    // счётчик записей: лишний set = лишний re-render у реального Qwik-хоста
    let writes = 0;
    let cur = s.value.value;
    Object.defineProperty(s.value, 'value', {
      get: () => cur,
      set: (v: number) => {
        writes++;
        cur = v;
      },
    });
    s.target.value = 100;
    fireTrackedTasks();
    const after = writes;
    fireTrackedTasks(); // та же цель — драйвер обязан молчать
    expect(writes).toBe(after);
    expect(cur).toBe(100);
  });

  it('повтор той же цели mid-flight не мешает доезду', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    s.target.value = 100;
    fireTrackedTasks();
    vc.drainAll(5); // в полёте
    s.target.value = 100; // повтор той же цели
    fireTrackedTasks();
    vc.drainAll();
    expect(Math.abs(s.value.value - 100)).toBeLessThan(0.5);
  });

  it('батчинг: два присваивания цели до одного прогона — доезжает к последней', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    s.target.value = 40;
    s.target.value = -30; // track возьмёт последнее
    fireTrackedTasks();
    vc.drainAll();
    expect(Math.abs(s.value.value - -30)).toBeLessThan(0.5);
  });

  it('смена цели mid-flight подхватывается (вторая цель доезжает)', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, SPRING, 'instant', vc.requestFrame);
    s.target.value = 100;
    fireTrackedTasks();
    vc.drainAll(5);
    s.target.value = -50;
    fireTrackedTasks();
    vc.drainAll();
    expect(Math.abs(s.value.value - -50)).toBeLessThan(0.5);
  });

  it('дефолтный spring исполняется: доезжает без явных параметров', async () => {
    const { useSpring } = await import('../src/qwik/index.js');
    const vc = makeVirtualClock();
    const s = useSpring(0, undefined, 'instant', vc.requestFrame);
    s.target.value = 100;
    fireTrackedTasks();
    vc.drainAll();
    expect(Math.abs(s.value.value - 100)).toBeLessThan(0.5);
  });
});

describe('bindings-api-surface-pin: qwik', () => {
  it('ровно запиненный набор runtime-экспортов', async () => {
    const qwik = await import('../src/qwik/index.js');
    expect(Object.keys(qwik).sort()).toEqual(['useSpring']);
  });
});
