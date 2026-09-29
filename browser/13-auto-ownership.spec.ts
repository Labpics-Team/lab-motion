/**
 * Реальные DOM/CSSOM/WAAPI-инварианты ./auto: MutationObserver ordering,
 * terminal fill cleanup и отсутствие retention после disconnect.
 */

import { expect, test } from './fixtures/harness';

test('transfer A→B до MutationObserver callback не отбирается старым owner', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { autoAnimate } = await import('/dist/auto/index.js');
    const left = document.createElement('div');
    const right = document.createElement('div');
    const node = document.createElement('div');
    left.appendChild(node);
    document.body.append(left, right);
    autoAnimate(left as never, { duration: 10, respectReducedMotion: false });

    right.appendChild(node);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const result = {
      inLeft: left.contains(node),
      inRight: right.contains(node),
      animations: node.getAnimations().length,
    };
    left.remove();
    right.remove();
    return result;
  });

  expect(result).toEqual({ inLeft: false, inRight: true, animations: 0 });
});

test('transfer активного ghost восстанавливает CSS и отменяет fill-effect', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { autoAnimate } = await import('/dist/auto/index.js');
    const left = document.createElement('div');
    const right = document.createElement('div');
    const node = document.createElement('div');
    node.style.position = 'relative';
    node.style.left = '7px';
    node.style.top = '8px';
    left.appendChild(node);
    document.body.append(left, right);
    autoAnimate(left as never, { duration: 10, respectReducedMotion: false });

    node.remove();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const animation = node.getAnimations()[0]!;
    right.appendChild(node);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const result = {
      inRight: right.contains(node),
      position: node.style.position,
      left: node.style.left,
      top: node.style.top,
      playState: animation.playState,
    };
    left.remove();
    right.remove();
    return result;
  });

  expect(result).toEqual({
    inRight: true,
    position: 'relative',
    left: '7px',
    top: '8px',
    playState: 'idle',
  });
});

test('две autoAnimate на одном parent оставляют exit одному writer', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { autoAnimate } = await import('/dist/auto/index.js');
    const parent = document.createElement('div');
    const node = document.createElement('div');
    parent.appendChild(node);
    document.body.appendChild(parent);
    const first = autoAnimate(parent as never, { duration: 10, respectReducedMotion: false });
    const second = autoAnimate(parent as never, { duration: 10, respectReducedMotion: false });

    node.remove();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const animation = node.getAnimations()[0];
    const active = {
      contained: parent.contains(node),
      animations: node.getAnimations().length,
      playState: animation?.playState,
    };
    const terminal = new Promise<void>((resolve) => {
      animation?.addEventListener('finish', () => resolve(), { once: true });
    });
    animation?.finish();
    await terminal;
    const finished = { contained: parent.contains(node) };
    first.disconnect();
    second.disconnect();
    parent.remove();
    return { active, finished };
  });

  expect(result).toEqual({
    active: { contained: true, animations: 1, playState: 'running' },
    finished: { contained: false },
  });
});

test('natural finish и внешний cancel оба являются terminal и снимают fill', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { autoAnimate } = await import('/dist/auto/index.js');
    const run = async (signal: 'finish' | 'cancel') => {
      const parent = document.createElement('div');
      const node = document.createElement('div');
      node.style.position = 'relative';
      parent.appendChild(node);
      document.body.appendChild(parent);
      autoAnimate(parent as never, { duration: 10, respectReducedMotion: false });
      node.remove();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const animation = node.getAnimations()[0]!;
      const terminal = new Promise<void>((resolve) => {
        animation.addEventListener(signal, () => resolve(), { once: true });
      });
      animation[signal]();
      await terminal;
      const report = {
        contained: parent.contains(node),
        position: node.style.position,
        playState: animation.playState,
      };
      parent.remove();
      return report;
    };
    return { finish: await run('finish'), cancel: await run('cancel') };
  });

  expect(result.finish).toEqual({ contained: false, position: 'relative', playState: 'idle' });
  expect(result.cancel).toEqual({ contained: false, position: 'relative', playState: 'idle' });
});

test('CSSOM lease round-trip сохраняет canonical value, presence и !important', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { autoAnimate } = await import('/dist/auto/index.js');
    const parent = document.createElement('div');
    const node = document.createElement('div');
    node.style.transform = 'translate(0.123456789px, 0.987654321px)';
    node.style.setProperty('position', 'relative', 'important');
    node.style.setProperty('left', '1.123456789px', 'important');
    parent.appendChild(node);
    document.body.appendChild(parent);
    const names = ['position', 'left', 'top'] as const;
    const read = () => names.map((name) => ({
      name,
      value: node.style.getPropertyValue(name),
      priority: node.style.getPropertyPriority(name),
    }));
    const before = read();
    autoAnimate(parent as never, { duration: 10, respectReducedMotion: false });

    node.remove();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const animation = node.getAnimations()[0]!;
    const terminal = new Promise<void>((resolve) => {
      animation.addEventListener('finish', () => resolve(), { once: true });
    });
    animation.finish();
    await terminal;
    const after = read();
    parent.remove();
    return { before, after };
  });

  expect(result.after).toEqual(result.before);
});
