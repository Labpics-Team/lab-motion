import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useSpring, vMotion } from '../src/vue/index.js';

describe('Vue Bindings', () => {
  it('useSpring returns animated ref matching target', async () => {
    const target = ref<number | string>(100);
    const value = useSpring(target);

    expect(value.value).toBe(100);

    target.value = 200;

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(value.value).toBe(200);
  });

  it('vMotion directive animates single style property', async () => {
    const el = { style: {} } as any;
    vMotion.mounted(el, {
      value: 100,
      arg: 'opacity',
      modifiers: {},
    });

    vMotion.updated(el, {
      value: 200,
      oldValue: 100,
      arg: 'opacity',
      modifiers: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(el.style.opacity).toBe('200');
  });

  it('vMotion directive animates object of style properties', async () => {
    const el = { style: {} } as any;
    vMotion.mounted(el, {
      value: { opacity: 1, top: 100 },
      modifiers: {},
    });

    vMotion.updated(el, {
      value: { opacity: 0.5, top: 200 },
      oldValue: { opacity: 1, top: 100 },
      modifiers: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(el.style.opacity).toBe('0.5');
    expect(el.style.top).toBe('200px');
  });
});
