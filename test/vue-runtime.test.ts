// @vitest-environment jsdom
/**
 * test/vue-runtime.test.ts — S36: Vue-биндинг в РЕАЛЬНОМ рантайме.
 *
 * Настоящий Vue 3 (createApp + h + mount в jsdom): реальные ref/watch/onUnmounted,
 * реальный async-ре-рендер (nextTick), реальный teardown по app.unmount().
 * useSpring: watch(target)→setTarget; onChange→value.value→ре-рендер. v-motion
 * директива: mounted→setTarget→запись в el.style. Закрывает класс «Vue-склейка
 * сломана в живом рантайме» (реактивность watch, nextTick-флаш, unmount-cleanup).
 * Клок инжектируется → детерминизм в live-рантайме.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, withDirectives, type App } from 'vue';
import { useSpring, useMotionValue, vMotion } from '../src/vue/index.js';

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  return {
    requestFrame: (cb: (ts?: number) => void): number => { q.push(cb); return 1; },
    drain(max = 2000): void { let n = 0; while (q.length > 0 && n++ < max) q.shift()!(); },
    pending: () => q.length,
  };
}

let apps: Array<{ app: App; container: HTMLElement }> = [];
function mount(comp: ReturnType<typeof defineComponent>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(comp);
  app.mount(container);
  apps.push({ app, container });
  return container;
}
afterEach(() => {
  for (const { app, container } of apps) { app.unmount(); container.remove(); }
  apps = [];
});

describe('Vue-биндинг в реальном Vue 3-рантайме', () => {
  it('useSpring: живой ре-рендер по изменению target-ref через клок', async () => {
    const clock = makeClock();
    const target = ref(0);
    const Comp = defineComponent({
      setup() {
        const x = useSpring(target, SPRING, 'instant', clock.requestFrame);
        return () => h('div', { id: 'box' }, x.value.toFixed(2));
      },
    });
    const c = mount(Comp);
    const box = () => c.querySelector('#box')!.textContent!;
    await nextTick();
    expect(Number(box())).toBe(0);

    target.value = 100; // watch → mv.setTarget
    await nextTick(); // флаш watch
    clock.drain(); // кадры → value.value обновляется реактивно
    await nextTick(); // флаш ре-рендер

    const v = Number(box());
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(100);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('useSpring settled: сходится к цели после полного прогона', async () => {
    const clock = makeClock();
    const target = ref(0);
    const Comp = defineComponent({
      setup() {
        const x = useSpring(target, SPRING, 'instant', clock.requestFrame);
        return () => h('div', { id: 'box' }, x.value.toFixed(4));
      },
    });
    const c = mount(Comp);
    await nextTick();
    target.value = 50;
    await nextTick();
    clock.drain();
    await nextTick();
    expect(Number(c.querySelector('#box')!.textContent)).toBeCloseTo(50, 1);
  });

  it('v-motion директива пишет в el.style через живой mount', async () => {
    const clock = makeClock();
    const Comp = defineComponent({
      setup() {
        return () =>
          withDirectives(h('div', { id: 'box' }), [
            [vMotion, { target: 1, property: 'opacity', from: 0, spring: SPRING, requestFrame: clock.requestFrame }],
          ]);
      },
    });
    const c = mount(Comp);
    await nextTick();
    clock.drain(); // mounted-хук уже поставил setTarget; гоним кадры
    await nextTick();
    const box = c.querySelector('#box') as HTMLElement;
    const v = Number(box.style.opacity);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('unmount вызывает destroy: цикл остановлен, эмиссий после нет', async () => {
    // useMotionValue.onUnmounted → mv.destroy() (как react/preact). Сильный
    // оракул: свой onChange-счётчик; после unmount destroy() очищает listeners
    // → повторный setTarget+drain не даёт эмиссий. Диверсия «убрать destroy» →
    // листенер жив, цикл гоняет → эмиссии → краснеет.
    const clock = makeClock();
    let mv!: ReturnType<typeof useMotionValue>;
    const Comp = defineComponent({
      setup() {
        mv = useMotionValue(0, SPRING, clock.requestFrame);
        return () => h('div', {}, 'x');
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = createApp(Comp);
    app.mount(container);
    await nextTick();

    let emits = 0;
    const off = mv.onChange(() => { emits += 1; });
    mv.setTarget(100);
    clock.drain();
    const before = emits;
    expect(before).toBeGreaterThan(1);

    app.unmount(); // onUnmounted → mv.destroy() → listeners.clear()

    mv.setTarget(0); // проба: цикл жив?
    clock.drain();
    expect(emits).toBe(before); // destroy погасил — ноль новых эмиссий
    off();
    container.remove();
  });
});
