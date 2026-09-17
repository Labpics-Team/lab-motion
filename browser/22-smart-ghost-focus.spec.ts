import { expect, test } from './fixtures/harness';

test('smart ghost остаётся focus-inert до последнего overlapping owner', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { captureSmart } = await import('/dist/smart/index.js');

    const outer = document.createElement('div');
    const inner = document.createElement('div');
    const ghost = document.createElement('button');
    outer.style.position = 'relative';
    inner.style.position = 'relative';
    outer.style.width = '160px';
    outer.style.height = '160px';
    inner.style.width = '80px';
    inner.style.height = '80px';
    ghost.dataset.motionKey = 'g';
    ghost.textContent = 'focus target';
    ghost.style.position = 'relative';
    ghost.style.left = '7px';
    ghost.style.top = '8px';
    ghost.style.width = '40px';
    ghost.style.height = '20px';
    ghost.style.opacity = '0.7';
    inner.append(ghost);
    outer.append(inner);
    document.body.append(outer);

    ghost.focus();
    const focusableBefore = document.activeElement === ghost && ghost.inert === false;

    const innerBefore = captureSmart(inner);
    ghost.remove();
    const innerFlight = innerBefore.animate();
    ghost.focus();
    const innerPinned =
      ghost.parentElement === inner && ghost.inert === true && document.activeElement !== ghost;

    // Второй controller получает тот же DOM identity, пока первый ещё владеет ghost.
    const outerBefore = captureSmart(outer);
    ghost.remove();
    const outerFlight = outerBefore.animate();
    ghost.focus();
    const overlapPinned =
      ghost.parentElement === outer && ghost.inert === true && document.activeElement !== ghost;

    // Самый опасный порядок: текущий physical host уходит раньше первого owner.
    outerFlight.cancel();
    ghost.focus();
    const transferredSafely =
      ghost.parentElement === inner && ghost.inert === true && document.activeElement !== ghost;

    innerFlight.cancel();
    const finalDetached = ghost.isConnected === false;
    const inertRestored = ghost.inert === false;

    // Consumer снова использует тот же identity: после terminal release фокус разрешён.
    document.body.append(ghost);
    ghost.focus();
    const focusRestored = document.activeElement === ghost;
    ghost.remove();
    outer.remove();

    return {
      focusableBefore,
      innerPinned,
      overlapPinned,
      transferredSafely,
      finalDetached,
      inertRestored,
      focusRestored,
    };
  });

  expect(result).toEqual({
    focusableBefore: true,
    innerPinned: true,
    overlapPinned: true,
    transferredSafely: true,
    finalDetached: true,
    inertRestored: true,
    focusRestored: true,
  });
});
