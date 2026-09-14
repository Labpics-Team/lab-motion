import { test } from './fixtures/harness';

test('smart exit ghost does not reacquire focus lifetime after app removal', async ({ page }) => {
  await page.setContent(`
    <style>
      #root { position: relative; width: 320px; height: 160px; }
      #gone { display: block; width: 120px; height: 40px; }
    </style>
    <div id="root"><button id="gone" data-motion-key="gone">Gone</button></div>
  `);

  const result = await page.evaluate(async () => {
    const { captureSmart } = await import('/dist/smart/index.js');
    const root = document.getElementById('root')!;
    const gone = document.getElementById('gone') as HTMLButtonElement;
    const before = gone.getBoundingClientRect();
    const frames: Array<(ts?: number) => void> = [];
    const capture = captureSmart(root, {
      respectReducedMotion: false,
      requestFrame: (cb) => { frames.push(cb); return frames.length; },
      getComputedStyle: (el) => window.getComputedStyle(el as Element),
      getScroll: () => ({ x: window.scrollX, y: window.scrollY }),
    });

    gone.remove(); // app membership ended before visual exit lifetime
    const handle = capture.animate();

    // Не исполняем queued frame: наблюдаем именно промежуток visual lifetime
    // между ghost-reinsert и terminal cleanup, как в owner-level injected-clock tests.
    const observation = {
      oldWidth: before.width,
      oldHeight: before.height,
      exited: handle.plan.exited.includes('gone'),
      reinserted: root.contains(gone),
      queuedFrames: frames.length,
      playing: handle.playing,
      inertBeforeFocus: gone.inert,
      tabIndex: gone.tabIndex,
      acceptedFocus: false,
    };
    gone.focus();
    observation.acceptedFocus = document.activeElement === gone;

    handle.cancel();
    await handle.finished;
    return observation;
  });

  console.log(`FOCUS_OBSERVATION=${JSON.stringify(result)}`);
  if (!(result.oldWidth > 0 && result.oldHeight > 0 && result.exited && result.reinserted && result.queuedFrames > 0 && result.playing)) {
    throw new Error(`POSITIVE_CONTROL_FAILED:${JSON.stringify(result)}`);
  }
  if (!result.inertBeforeFocus || result.acceptedFocus) {
    throw new Error(`FOCUS_LIFETIME_VIOLATION:${JSON.stringify(result)}`);
  }
});
