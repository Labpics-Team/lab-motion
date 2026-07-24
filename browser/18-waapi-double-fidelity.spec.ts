/**
 * 18-waapi-double-fidelity.spec.ts — верность разделяемого тестового двойника.
 *
 * ЗАЧЕМ. Вся unit-сьюта исполняется против двойника WAAPI
 * (test/support/waapi-double.ts), а он верен ровно настолько, насколько мы это
 * проверили. Дефекты #240 прошли мимо тестов именно потому, что тогдашние
 * самодельные двойники не воспроизводили контракт движка. Этот спек проверяет
 * ТЕ ЖЕ четыре утверждения, что test/waapi-double-contract.test.ts, но на
 * НАСТОЯЩИХ Chromium/Firefox/WebKit. Расхождение роняет либо unit-контракт,
 * либо эту матрицу — «двойник тихо разошёлся с движком» становится невозможным.
 *
 * Детерминизм: ноль sleep. Завершение вызывается явно (`Animation.finish()`),
 * события ловятся через addEventListener, промисы — через await.
 */

import { expect, test } from './fixtures/harness';

test('cancel() переводит в idle и обнуляет currentTime', async ({ page }) => {
  const r = await page.evaluate(() => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    const before = animation.playState;
    animation.cancel();
    const after = { playState: animation.playState, currentTime: animation.currentTime };
    el.remove();
    return { before, after };
  });

  expect(r.before).toBe('running');
  // Ровно это свойство сделало отменённый прогон неотличимым от нестартовавшего
  // и убило реестр прогонов компилятора (#240).
  expect(r.after.playState).toBe('idle');
  expect(r.after.currentTime).toBe(null);
});

test('естественное завершение: playState=finished и событие finish у слушателя', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    let finishes = 0;
    // Событие рассылается задачей очереди, а не синхронно, поэтому ждём именно
    // ЕГО, а не таймер: отсутствие события даст честный таймаут спека, а не
    // «зелёный, потому что подождали недостаточно».
    const fired = new Promise<void>((resolve) => {
      animation.addEventListener('finish', () => { finishes++; resolve(); }, { once: true });
    });
    const midState = animation.playState;

    animation.finish();
    await animation.finished;
    await fired;

    const result = { midState, finishes, playState: animation.playState };
    el.remove();
    return result;
  });

  expect(r.midState).toBe('running');
  expect(r.playState).toBe('finished');
  expect(r.finishes).toBe(1);
});

test('finished отклоняется AbortError при cancel', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const animation = el.animate([{ opacity: 1 }], { duration: 300 });
    let name = 'нет отказа';
    const settled = animation.finished.then(
      () => { name = 'резолвился'; },
      (error: unknown) => { name = (error as { name?: string })?.name ?? 'без имени'; },
    );
    animation.cancel();
    await settled;
    el.remove();
    return name;
  });

  expect(r).toBe('AbortError');
});

test('commitStyles() переносит текущее значение эффекта в element.style', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const el = document.createElement('div');
    el.style.opacity = '0';
    document.body.appendChild(el);
    const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 300,
      fill: 'both',
    });
    animation.finish();
    await animation.finished;
    animation.commitStyles();
    const inline = el.style.opacity;
    animation.cancel();
    // Продукт обязан звать commitStyles ДО cancel — иначе значение отскочит.
    const afterCancel = el.style.opacity;
    el.remove();
    return { inline, afterCancel };
  });

  expect(r.inline).toBe('1');
  expect(r.afterCancel).toBe('1');
});
