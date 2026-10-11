import { describe, expect, it } from 'vitest';
import { SurfaceBatch, type SurfaceUnit } from '../src/animate/surface-batch.js';
import type { FrameLoop } from '../src/frame/index.js';

function harness() {
  let update: ((ts?: number) => void) | undefined;
  let render: ((ts?: number) => void) | undefined;
  const frame: FrameLoop = {
    read: () => () => {},
    update(cb) { update = cb; return () => { if (update === cb) update = undefined; }; },
    render(cb) { render = cb; return () => { if (render === cb) render = undefined; }; },
    cancelAll() {},
  };
  const batch = new SurfaceBatch(frame);
  const events: string[] = [];
  let writes = 0;
  function unit(id: number, paused = false) {
    let slot = -1;
    const entry: SurfaceUnit = {
      get _batchSlot() { return slot; },
      set _batchSlot(value) { writes++; slot = value; },
      _updateStep() { events.push(`u${id}`); },
      _renderStep() { events.push(`r${id}`); },
      _batchAbort() { batch._remove(entry, paused); },
      _batchRollback() { batch._remove(entry, paused); },
    };
    batch._add(entry, paused);
    return entry;
  }
  return { batch, unit, events,
    get writes() { return writes; },
    get storage() { return (batch as unknown as { _units: Array<SurfaceUnit | undefined> })._units; },
    tick() { const u = update, r = render; u?.(16); r?.(16); },
  };
}

describe('массовая смена владельцев поверхностей', () => {
  for (const count of [1, 64, 1024]) for (const paused of [false, true]) {
    it(`${count} поверхностей, paused=${paused}: линейная подготовка и ограниченный список`, () => {
      const host = harness();
      const live = Array.from({ length: count }, (_, id) => host.unit(id, paused));
      const start = host.writes;
      const replacements = count * 4;
      for (let step = 0; step < replacements; step++) {
        const index = step % count;
        const previous = live[index]!;
        // animate сначала устанавливает преемника, затем отзывает прежнего владельца.
        live[index] = host.unit(count + step, paused);
        host.batch._remove(previous, paused);
        expect(previous._batchSlot).toBe(-1);
        expect(host.storage.length).toBeLessThanOrEqual(2 * (count + 1));
      }
      // Учтены назначения при add/remove и все перенумерации выживших slots.
      expect(host.writes - start).toBeLessThanOrEqual(4 * replacements + count);
      expect(host.storage.filter(Boolean)).toEqual(live);
      for (const entry of live) expect(host.storage[entry._batchSlot]).toBe(entry);
      for (const entry of live) host.batch._remove(entry, paused);
      expect(host.storage).toHaveLength(0);
    });
  }

  it('уплотнение сохраняет порядок выживших поверхностей и новые ждут следующего кадра', () => {
    const host = harness();
    const live = Array.from({ length: 12 }, (_, id) => host.unit(id));
    let inserted = false;
    const update = live[0]!._updateStep;
    live[0]!._updateStep = () => {
      update();
      if (inserted) return;
      inserted = true;
      for (let id = 1; id < 9; id++) host.batch._remove(live[id]!, false);
      for (let id = 12; id < 24; id++) live.push(host.unit(id));
    };
    host.tick();
    expect(host.events).toEqual(['u0', 'u9', 'u10', 'u11', 'r0', 'r9', 'r10', 'r11']);
    host.events.length = 0;
    host.tick();
    const ids = [0, 9, 10, 11, ...Array.from({ length: 12 }, (_, i) => i + 12)];
    expect(host.events).toEqual([...ids.map(id => `u${id}`), ...ids.map(id => `r${id}`)]);
    expect(host.storage).toHaveLength(ids.length);
    for (const entry of live) host.batch._remove(entry, false);
    expect(host.storage).toHaveLength(0);
  });

  it('пауза и возобновление сохраняют адреса, а удалённые entries не оживают', () => {
    const host = harness();
    const live = Array.from({ length: 128 }, (_, id) => host.unit(id, true));
    for (let id = 0; id < 100; id++) host.batch._remove(live[id]!, true);
    const tail = live.slice(100);
    const addresses = tail.map(entry => entry._batchSlot);
    const writes = host.writes;
    for (const entry of tail) host.batch._activate(entry);
    expect(tail.map(entry => entry._batchSlot)).toEqual(addresses);
    expect(host.writes).toBe(writes);
    host.tick();
    const ids = Array.from({ length: 28 }, (_, id) => 100 + id);
    expect(host.events).toEqual([...ids.map(id => `u${id}`), ...ids.map(id => `r${id}`)]);
    expect(host.storage).toEqual(tail);
    for (const entry of tail) {
      host.batch._deactivate(entry);
      host.batch._remove(entry, true);
    }
    expect(host.storage).toHaveLength(0);
  });
});
