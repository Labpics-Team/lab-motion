import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/harness';

const SHOWCASE = '/site/dist/index.html';
const EXAMPLE = `import { animate } from '@labpics/motion/animate';

await animate('.card', { x: 240, opacity: 1 }, {
  spring: { mass: 1, stiffness: 170, damping: 26 },
  stagger: 40,
}).finished;`;

function watchRuntimeFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => failures.push(`requestfailed: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`http ${response.status()}: ${response.url()}`);
  });
  return failures;
}

function translation(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.locator(selector).evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42 };
  });
}

test('showcase renders every proof and settles without runtime failures', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.goto(SHOWCASE);

  await expect(page).toHaveTitle(/Lab Motion/);
  await expect(page.getByRole('heading', { name: 'Motion that survives interruption.' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Live spring preview' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Spring animation preview' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Staggered dots animation preview' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Retargetable object animation preview' })).toBeVisible();
  await expect(page.locator('.stage-coordinate')).toHaveCount(0);
  await expect(page.locator('[data-card="spring"] [data-state]')).toHaveText('complete');
  await expect(page.locator('[data-card="stagger"] [data-state]')).toHaveText('complete');
  await expect(page.getByRole('status')).toHaveCount(3);
  await expect.poll(() => translation(page, '[data-preview="spring-object"]')).toEqual({ x: 112, y: 0 });
  expect(failures).toEqual([]);
});

test('spring Replay starts a new observed trajectory and reaches its endpoint', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.goto(SHOWCASE);
  const state = page.locator('[data-card="spring"] [data-state]');
  await expect(state).toHaveText('complete');

  const before = await translation(page, '[data-preview="spring-object"]');
  await page.locator('[data-action="replay-spring"]').click();
  await expect(state).toHaveText('running');
  await expect.poll(async () => (await translation(page, '[data-preview="spring-object"]')).x).not.toBe(before.x);
  await expect(state).toHaveText('complete');
  await expect.poll(async () => (await translation(page, '[data-preview="spring-object"]')).x).toBeCloseTo(112, 1);
  expect(failures).toEqual([]);
});

test('stagger Replay exposes delayed visual ordering before all items settle', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.goto(SHOWCASE);
  const state = page.locator('[data-card="stagger"] [data-state]');
  await expect(state).toHaveText('complete');

  await page.locator('[data-action="replay-stagger"]').click();
  await expect(state).toHaveText('running');
  await expect.poll(async () => page.locator('[data-stagger-item]').evaluateAll((items) => {
    const opacity = items.map((item) => Number(getComputedStyle(item).opacity));
    return Math.max(...opacity) - Math.min(...opacity);
  })).toBeGreaterThan(0.1);
  await expect(state).toHaveText('complete');
  await expect.poll(async () => page.locator('[data-stagger-item]').evaluateAll((items) =>
    items.every((item) => Math.abs(Number(getComputedStyle(item).opacity) - 1) < 0.001),
  )).toBe(true);
  expect(failures).toEqual([]);
});

test('retarget changes the observed destination and settles at the redirected target', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.goto(SHOWCASE);

  await page.locator('[data-action="retarget"]').click();
  await expect(page.locator('[data-card="retarget"] [data-state]')).toHaveText('running');
  await expect.poll(() => page.locator('[data-retarget-copy]').textContent()).toMatch(/Redirecting|Retargeted/);

  await page.locator('[data-action="reset-retarget"]').click();
  await expect(page.locator('[data-card="retarget"] [data-state]')).toHaveText('ready');
  await expect(page.locator('[data-retarget-copy]')).toHaveText('Start a transition, then redirect it without a teleport.');
  await expect.poll(async () => (await translation(page, '[data-preview="retarget-object"]')).x).toBe(-112);

  await page.locator('[data-action="retarget"]').click();
  await expect(page.locator('[data-card="retarget"] [data-state]')).toHaveText('complete');
  await expect.poll(async () => (await translation(page, '[data-preview="retarget-object"]')).x).toBeCloseTo(-34, 1);
  expect(failures).toEqual([]);
});

test('Copy sends the exact public example and reports success', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(text: string) {
          (window as typeof window & { __showcaseCopied?: string }).__showcaseCopied = text;
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto(SHOWCASE);

  await page.locator('[data-copy]').click();
  await expect(page.locator('[data-copy-status]')).toHaveText('Copied to clipboard.');
  expect(await page.evaluate(() =>
    (window as typeof window & { __showcaseCopied?: string }).__showcaseCopied,
  )).toBe(EXAMPLE);
  expect(failures).toEqual([]);
});

test('system reduced motion resolves previews without native animations', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(SHOWCASE);

  await expect(page.locator('[data-action="toggle-motion"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-action="toggle-motion"]')).toBeDisabled();
  await expect(page.locator('[data-action="toggle-motion"]')).toHaveText('System setting: reduced motion');
  await expect(page.locator('[data-site-status]')).toHaveText('Your system reduced-motion preference is active; the preview follows it.');
  await expect(page.locator('[data-card="spring"] [data-state]')).toHaveText('reduced');
  await expect(page.locator('[data-card="stagger"] [data-state]')).toHaveText('reduced');
  await expect.poll(() => page.locator('[data-preview], [data-stagger-item]').evaluateAll((items) =>
    items.reduce((count, item) => count + item.getAnimations().length, 0),
  )).toBe(0);
  await expect.poll(async () => (await translation(page, '[data-preview="spring-object"]')).x).toBeCloseTo(112, 1);
  expect(failures).toEqual([]);
});

test('changing the system motion preference updates the effective UI state', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(SHOWCASE);
  await expect(page.locator('[data-card="spring"] [data-state]')).toHaveText('complete');

  await page.emulateMedia({ reducedMotion: 'reduce' });

  await expect(page.locator('[data-action="toggle-motion"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-action="toggle-motion"]')).toBeDisabled();
  await expect(page.locator('[data-site-status]')).toHaveText('Your system reduced-motion preference is active; the preview follows it.');
  await expect(page.locator('[data-card="spring"] [data-state]')).toHaveText('reduced');
  await expect(page.locator('[data-card="stagger"] [data-state]')).toHaveText('reduced');
  expect(failures).toEqual([]);
});

test('enabling reduced motion clears the pending autonomous hero replay', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const timers = new Map<number, { cleared: boolean; delay: number; fired: boolean }>();
    let heldTimerId = -1;
    (window as typeof window & { __showcaseTimers?: typeof timers }).__showcaseTimers = timers;
    window.setTimeout = ((callback: TimerHandler, delay = 0, ...args: unknown[]) => {
      if (delay === 700) {
        const id = heldTimerId--;
        timers.set(id, { cleared: false, delay, fired: false });
        return id;
      }
      let id = 0;
      const tracked = typeof callback === 'function'
        ? (...callbackArgs: unknown[]) => {
            const timer = timers.get(id);
            if (timer) timer.fired = true;
            return Reflect.apply(callback, window, callbackArgs);
          }
        : callback;
      id = nativeSetTimeout(tracked, delay, ...args) as unknown as number;
      if (delay === 700) timers.set(id, { cleared: false, delay, fired: false });
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id = 0) => {
      const timer = timers.get(id as unknown as number);
      if (timer) {
        timer.cleared = true;
        return;
      }
      nativeClearTimeout(id);
    }) as typeof window.clearTimeout;
  });
  await page.goto(SHOWCASE);
  await expect(page.locator('[data-card="spring"] [data-state]')).toHaveText('complete');
  await expect(page.locator('[data-card="stagger"] [data-state]')).toHaveText('complete');

  await expect.poll(() => page.evaluate(() => {
    const timers = (window as typeof window & {
      __showcaseTimers?: Map<number, { cleared: boolean; delay: number; fired: boolean }>;
    }).__showcaseTimers;
    return [...(timers?.values() ?? [])].some((timer) => timer.delay === 700 && !timer.cleared && !timer.fired);
  })).toBe(true);
  const pendingHeroTimers = await page.evaluate(() => {
    const timers = (window as typeof window & {
      __showcaseTimers?: Map<number, { cleared: boolean; delay: number; fired: boolean }>;
    }).__showcaseTimers;
    return [...(timers?.entries() ?? [])]
      .filter(([, timer]) => timer.delay === 700 && !timer.cleared && !timer.fired)
      .map(([id]) => id);
  });

  await page.locator('[data-action="toggle-motion"]').click();

  expect(await page.evaluate((ids) => {
    const timers = (window as typeof window & {
      __showcaseTimers?: Map<number, { cleared: boolean; delay: number; fired: boolean }>;
    }).__showcaseTimers;
    return ids.every((id) => timers?.get(id)?.cleared === true);
  }, pendingHeroTimers)).toBe(true);
  expect(failures).toEqual([]);
});

test('small functional text meets the WCAG AA contrast floor', async ({ page }) => {
  await page.goto(SHOWCASE);

  const ratios = await page.locator('.card-kicker, .card-state, .code-card-bar').evaluateAll((elements) => {
    function channel(value: number): number {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }
    function luminance(color: string): number {
      const [r = 0, g = 0, b = 0] = color.match(/[\d.]+/g)?.map(Number) ?? [];
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    }
    return elements.map((element) => {
      const style = getComputedStyle(element);
      const foreground = luminance(style.color);
      const background = luminance(getComputedStyle(element.closest('.proof-card, .code-card') ?? document.body).backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  });

  expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
});

test('keyboard toggle enforces reduced motion and the phone layout does not overflow', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(SHOWCASE);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  let focusedAction: string | undefined;
  for (let step = 0; step < 12 && focusedAction !== 'toggle-motion'; step++) {
    await page.keyboard.press('Tab');
    focusedAction = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action);
  }
  expect(focusedAction).toBe('toggle-motion');
  await page.keyboard.press('Enter');

  const toggle = page.locator('[data-action="toggle-motion"]');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText('Use full motion');
  await expect(page.locator('[data-card="spring"] [data-state]')).toHaveText('reduced');
  await expect(page.locator('[data-card="stagger"] [data-state]')).toHaveText('reduced');
  expect(await page.locator('[data-preview], [data-stagger-item]').evaluateAll((items) =>
    items.reduce((count, item) => count + item.getAnimations().length, 0),
  )).toBe(0);
  expect(failures).toEqual([]);
});

test('hero preview stops off-screen and resumes when it re-enters the viewport', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.goto(SHOWCASE);
  const orb = page.locator('[data-preview="hero-orb"]');
  await expect.poll(() => orb.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => orb.evaluate((element) => element.getAnimations().length)).toBe(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => orb.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});
