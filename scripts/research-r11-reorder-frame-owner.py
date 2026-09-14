from pathlib import Path

DRIVER = Path('src/projection/driver.ts')
TEST = Path('test/projection-driver.test.ts')

text = DRIVER.read_text()
marker = """  /** Переиспользуемый выход солвера (ноль аллокаций на кадр). */
  const solved = { value: 0, velocity: 0 };
"""
replacement = marker + """

  // Один controller владеет максимум одной физической frame-reservation.
  // Повторный play/cancel/seek меняет только логический callback внутри неё:
  // stale generation не оставляет второй rAF висеть рядом с новым полётом.
  let pendingTick: ((ts?: number) => void) | null = null;
  let frameReserved = false;
  let frameFallback: ReturnType<typeof setTimeout> | null = null;

  const clearFrameFallback = (): void => {
    if (frameFallback === null) return;
    clearTimeout(frameFallback);
    frameFallback = null;
  };

  const clearPendingTick = (): void => {
    pendingTick = null;
  };

  const scheduleFrame = (cb: (ts?: number) => void): void => {
    pendingTick = cb;
    if (frameReserved) return;
    if (requestFrame === undefined) return;

    frameReserved = true;
    let synchronous = true;
    let delivered = false;
    const fire = (ts?: number): void => {
      if (delivered) return;
      if (synchronous) {
        if (frameFallback === null) frameFallback = setTimeout(() => fire(undefined), 0);
        return;
      }
      delivered = true;
      clearFrameFallback();
      frameReserved = false;
      const latest = pendingTick;
      pendingTick = null;
      latest?.(ts);
    };

    let handle: number;
    try {
      handle = requestFrame(fire);
    } catch (error) {
      delivered = true;
      frameReserved = false;
      clearPendingTick();
      clearFrameFallback();
      throw error;
    }
    synchronous = false;
    if (handle == 0 && frameFallback === null) frameFallback = setTimeout(() => fire(undefined), 0);
  };
"""
if text.count(marker) != 1:
    raise SystemExit('driver solved marker drifted')
text = text.replace(marker, replacement, 1)

old_schedule = """    const schedule = (cb: (ts?: number) => void): void => {
      if (requestFrame === undefined) {
        // Без шва и без rAF полёт невозможен честно — identity сразу (канон flip :251-256).
        settle(projector);
        return;
      }
      const handle = requestFrame(cb);
      if (handle === 0) setTimeout(() => cb(undefined), 0); // non-draining шов (flip :258)
    };
"""
new_schedule = """    const schedule = (cb: (ts?: number) => void): void => {
      if (requestFrame === undefined) {
        // Без шва и без rAF полёт невозможен честно — identity сразу (канон flip :251-256).
        settle(projector);
        return;
      }
      scheduleFrame(cb);
    };
"""
if text.count(old_schedule) != 1:
    raise SystemExit('driver schedule marker drifted')
text = text.replace(old_schedule, new_schedule, 1)

old_emit = """    } catch (error) {
      generation++;
      phase = 'canceled';
      vHat = 0;
      throw error;
    }
"""
new_emit = """    } catch (error) {
      generation++;
      phase = 'canceled';
      vHat = 0;
      clearPendingTick();
      throw error;
    }
"""
if text.count(old_emit) != 1:
    raise SystemExit('emit marker drifted')
text = text.replace(old_emit, new_emit, 1)

old_settle = """  const settle = (projector: Projector): void => {
    generation++;
"""
new_settle = """  const settle = (projector: Projector): void => {
    generation++;
    clearPendingTick();
"""
if text.count(old_settle) != 1:
    raise SystemExit('settle marker drifted')
text = text.replace(old_settle, new_settle, 1)

old_cancel = """    cancel(): void {
      if (flight === null || phase === 'rest' || phase === 'canceled') return;
      generation++;
      phase = 'canceled';
      vHat = 0;
"""
new_cancel = """    cancel(): void {
      if (flight === null || phase === 'rest' || phase === 'canceled') return;
      generation++;
      clearPendingTick();
      phase = 'canceled';
      vHat = 0;
"""
if text.count(old_cancel) != 1:
    raise SystemExit('cancel marker drifted')
text = text.replace(old_cancel, new_cancel, 1)

old_seek = """    seek(p: number): void {
      if (flight === null) return;
      generation++; // пружина погашена
"""
new_seek = """    seek(p: number): void {
      if (flight === null) return;
      generation++; // пружина погашена
      clearPendingTick();
"""
if text.count(old_seek) != 1:
    raise SystemExit('seek marker drifted')
text = text.replace(old_seek, new_seek, 1)
DRIVER.write_text(text)

t = TEST.read_text()
addition = """

describe('projection/driver: единственная физическая frame-reservation', () => {
  it('mid-flight play заменяет stale callback, не добавляя второй pending rAF', () => {
    const clock = makeClock();
    const controls = createProjection({ requestFrame: clock.requestFrame, onFrame: () => {} });
    controls.play([{ id: 'a', first: F, last: L }]);
    expect(clock.pending()).toBe(1);

    controls.play([{ id: 'a', last: { x: 300, y: 0, width: 100, height: 100 } }]);
    expect(clock.pending()).toBe(1);

    clock.step(16);
    expect(clock.pending()).toBe(1);
    controls.cancel();
    clock.step(16);
    expect(clock.pending()).toBe(0);
  });
});
"""
if 'единственная физическая frame-reservation' in t:
    raise SystemExit('regression test already exists')
TEST.write_text(t + addition)
