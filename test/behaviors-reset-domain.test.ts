import { describe, expect, it } from 'vitest';
import { createBottomSheet } from '../src/behaviors/index.js';

const point = (y: number, t: number) => ({ x: 0, y, t });

describe('./behaviors — tracker reset при смене цели', () => {
  it('обычный getter точки не мешает завершить разрешённый flick', () => {
    const sheet = createBottomSheet({ snapPoints: [0, 100, 200] });
    sheet.pointerDown(point(0, 0));
    sheet.pointerMove(point(50, 0.1));
    let read = false;

    sheet.pointerUp({ get x() { read = true; return 0; }, y: 200, t: 0.2 });

    expect(read).toBe(true);
    expect(sheet.state).toMatchObject({ value: 200, snapIndex: 2, phase: 'settle' });
    sheet.destroy();
  });

  it('snapTo внутри getter точки сохраняет samples ещё исполняемого pointerUp', () => {
    const sheet = createBottomSheet({ snapPoints: [0, 100, 200] });
    sheet.pointerDown(point(0, 0));
    sheet.pointerMove(point(50, 0.1));
    let redirected = false;

    sheet.pointerUp({
      get x() {
        if (!redirected) { redirected = true; sheet.snapTo(1); }
        return 0;
      },
      y: 200,
      t: 0.2,
    });

    // Последние samples: y=50 при t=.1 и y=200 при t=.2. Скорость 1500 px/s
    // из позиции 100 проецируется выше 200, поэтому прежний target — snap 2.
    expect(redirected).toBe(true);
    expect(sheet.state).toMatchObject({ value: 200, snapIndex: 2, phase: 'settle' });
    sheet.destroy();
  });
});
