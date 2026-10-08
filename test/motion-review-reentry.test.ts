import { afterEach, expect, it, vi } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import { frame } from '../src/frame/index.js';
import { value } from '../src/motion/value.js';
import type { Playback } from '../src/motion/types.js';

afterEach(() => { frame.cancelAll(); vi.unstubAllGlobals(); });

it('вложенный запуск из начального уведомления сохраняет нового владельца', async () => {
  const v = value(0); let nested: Playback | undefined;
  v.subscribe(n => { if (n === 1) nested = v.animate([2, 20], { duration: 1000, ease: 'linear' }); });
  const first = v.animate([1, 100], { duration: 1000, ease: 'linear' });
  try {
    expect(first.state).toBe('stopped'); expect(nested?.state).toBe('running'); expect(v.get()).toBe(2);
    first.finish(); nested!.seek(500); expect(v.get()).toBe(11);
    v.dispose(); expect(await nested!.finished).toEqual({ status: 'stopped' }); expect(await first.finished).toEqual({ status: 'stopped' });
  } finally { v.dispose(); first.stop(); nested?.stop(); }
});

it('ошибка прежнего уведомления не останавливает вложенного преемника', async () => {
  const v = value(0), error = new Error('old listener'); let nested: Playback | undefined;
  const off = v.subscribe(n => {
    if (n === 1) { nested = v.animate([2, 20], { duration: 1000, ease: 'linear' }); throw error; }
  });
  try {
    expect(() => v.animate([1, 100], { duration: 1000, ease: 'linear' })).toThrow(error);
    expect(nested?.state).toBe('running'); off(); nested!.seek(500); expect(v.get()).toBe(11);
    nested!.finish(); expect(await nested!.finished).toEqual({ status: 'finished' }); expect(v.get()).toBe(20);
  } finally { v.dispose(); nested?.stop(); }
});

it('смешанные свойства читают опции один раз и применяют times только к авторским кадрам', () => {
  const h = harness(); let reads = 0;
  const run = h.runtime.animate(h.element, { x: 100, opacity: [0, 1, 0] }, {
    get duration() { reads++; return 300; }, ease: 'linear', times: [0, .2, 1],
  });
  try {
    expect(reads).toBe(1); run.seek(60); expect(h.x()).toBe(20); expect(h.values.get('opacity')).toBe('1');
    run.seek(180); expect(h.x()).toBe(60); expect(Number(h.values.get('opacity'))).toBeCloseTo(.5, 10);
  } finally { run.stop(); }
});
