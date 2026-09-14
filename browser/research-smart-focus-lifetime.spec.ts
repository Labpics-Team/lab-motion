import { expect, test } from './fixtures/harness';

test('smart exit ghost does not reacquire focus lifetime after app removal', async ({ page }) => {
  await page.setContent('<div id="root"><button id="gone" data-motion-key="gone">Gone</button></div>');

  const result = await page.evaluate(async () => {
    const { captureSmart } = await import('/dist/smart/index.js');
    const root = document.getElementById('root')!;
    const gone = document.getElementById('gone') as HTMLButtonElement;
    const capture = captureSmart(root);

    gone.remove(); // app membership ended before visual exit lifetime
    const handle = capture.animate();

    const reinserted = root.contains(gone);
    const inertBeforeFocus = gone.inert;
    const tabIndex = gone.tabIndex;
    gone.focus();
    const acceptedFocus = document.activeElement === gone;

    handle.cancel();
    await handle.finished;
    return { reinserted, inertBeforeFocus, tabIndex, acceptedFocus };
  });

  expect(result.reinserted).toBe(true); // positive control: visual ghost really exists
  // motion-composition/1 target law: visual lifetime alone must not grant focus lifetime.
  expect(result.inertBeforeFocus).toBe(true);
  expect(result.acceptedFocus).toBe(false);
});
