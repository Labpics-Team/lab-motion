import { describe, expect, it } from 'vitest';
import { createStateCascade } from '../src/behaviors/index.js';

type Visual = {
  scale: number;
  opacity: number;
  background: string;
  x: number;
};

describe('createStateCascade: property-level intent ownership', () => {
  it('hover → press → pointerleave → release возвращает hover/base по собственности свойства, не по порядку событий', () => {
    const state = createStateCascade<Visual>();
    const base = state.createLayer({ scale: 1, opacity: 1, background: 'neutral' });
    const hover = state.createLayer();
    const press = state.createLayer();

    hover.set({ scale: 1.04 });
    expect(state.get('scale')).toBe(1.04);
    press.set({ scale: 0.96 });
    expect(state.get('scale')).toBe(0.96);

    // pointerleave пока press ещё активен: hover не должен украсть scale.
    hover.clear();
    expect(state.get('scale')).toBe(0.96);
    press.clear();
    expect(state.get('scale')).toBe(1);
    expect(state.get('opacity')).toBe(1);
    expect(base.active).toBe(true);
  });

  it('разные состояния одновременно владеют разными свойствами', () => {
    const state = createStateCascade<Visual>();
    state.createLayer({ scale: 1, opacity: 1, background: 'neutral' });
    const selected = state.createLayer({ background: 'accent' });
    const hover = state.createLayer({ scale: 1.03 });
    expect(state.snapshot()).toEqual({ scale: 1.03, opacity: 1, background: 'accent' });
    hover.clear();
    expect(state.snapshot()).toEqual({ scale: 1, opacity: 1, background: 'accent' });
    expect(selected.active).toBe(true);
  });

  it('обновление скрытого нижнего слоя не эмитит бесполезную работу, но становится актуальным после clear верхнего', () => {
    const state = createStateCascade<Visual>();
    const base = state.createLayer({ scale: 1 });
    const press = state.createLayer({ scale: 0.9 });
    let emissions = 0;
    state.subscribe(() => { emissions++; });

    for (let i = 0; i < 1000; i++) base.set({ scale: 1 + i / 1000 });
    expect(emissions).toBe(0);
    expect(state.get('scale')).toBe(0.9);

    press.clear();
    expect(emissions).toBe(1);
    expect(state.get('scale')).toBeCloseTo(1.999, 12);
  });

  it('частичное обновление верхнего слоя освобождает удалённый ключ нижнему владельцу', () => {
    const state = createStateCascade<Visual>();
    state.createLayer({ scale: 1, opacity: 1 });
    const exit = state.createLayer({ scale: 0.98, opacity: 0 });
    expect(state.snapshot()).toEqual({ scale: 0.98, opacity: 0 });
    exit.set({ opacity: 0.2 });
    expect(state.snapshot()).toEqual({ scale: 1, opacity: 0.2 });
  });

  it('различает owned undefined и полное удаление свойства', () => {
    type Maybe = { x: number | undefined };
    const state = createStateCascade<Maybe>();
    const base = state.createLayer({ x: 4 });
    const top = state.createLayer({ x: undefined });
    const own = state.snapshot();
    expect(Object.hasOwn(own, 'x')).toBe(true);
    expect(own.x).toBeUndefined();
    top.clear();
    expect(state.get('x')).toBe(4);
    base.clear();
    expect(Object.hasOwn(state.snapshot(), 'x')).toBe(false);
  });

  it('shallow-snapshot target не меняется от внешней мутации объекта', () => {
    const state = createStateCascade<Visual>();
    const target: Partial<Visual> = { scale: 1 };
    state.createLayer(target);
    target.scale = 9;
    expect(state.get('scale')).toBe(1);
  });

  it('same-effective-value меняет ownership без ложного emit', () => {
    const state = createStateCascade<Visual>();
    const base = state.createLayer({ scale: 1 });
    const hover = state.createLayer();
    let emissions = 0;
    state.subscribe(() => { emissions++; });
    hover.set({ scale: 1 });
    expect(emissions).toBe(0);
    base.set({ scale: 2 });
    expect(emissions).toBe(0);
    hover.clear();
    expect(emissions).toBe(1);
    expect(state.get('scale')).toBe(2);
  });

  it('patch сообщает changed отдельно от removed', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ scale: 1, opacity: 1 });
    const patch = layer.set({ scale: 2 });
    expect(patch.changed).toEqual({ scale: 2 });
    expect(patch.removed).toEqual(['opacity']);
  });

  it('destroy идемпотентен и делает старые layer handles инертными', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ scale: 1 });
    let emissions = 0;
    state.subscribe(() => { emissions++; });
    state.destroy();
    state.destroy();
    layer.set({ scale: 2 });
    layer.clear();
    expect(state.snapshot()).toEqual({});
    expect(layer.active).toBe(false);
    expect(emissions).toBe(0);
  });
});
