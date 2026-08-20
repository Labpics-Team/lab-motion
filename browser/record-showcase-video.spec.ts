import { test, devices } from '@playwright/test';

test('record showcase video', async ({ browser }) => {
  test.setTimeout(120_000);

  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
    recordVideo: {
      dir: 'C:\\Users\\Daniel\\lab-motion-previews',
      size: { width: 1280, height: 720 },
    },
  });

  const page = await context.newPage();
  await page.goto('http://localhost:4173');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Spring replay
  const springBtn = page.locator('[data-action="replay-spring"]');
  if (await springBtn.count() > 0) {
    await springBtn.click();
    await page.waitForTimeout(3000);
  }

  // Stagger replay
  const staggerBtn = page.locator('[data-action="replay-stagger"]');
  if (await staggerBtn.count() > 0) {
    await staggerBtn.click();
    await page.waitForTimeout(3000);
  }

  // Retarget
  const retargetBtn = page.locator('[data-action="retarget"]');
  if (await retargetBtn.count() > 0) {
    await retargetBtn.click();
    await page.waitForTimeout(3500);
  }

  // Reduced motion toggle
  const toggleBtn = page.locator('[data-action="toggle-motion"]');
  if (await toggleBtn.count() > 0) {
    await toggleBtn.click();
    await page.waitForTimeout(2000);
    if (await springBtn.count() > 0) {
      await springBtn.click();
      await page.waitForTimeout(2000);
    }
    if (await staggerBtn.count() > 0) {
      await staggerBtn.click();
      await page.waitForTimeout(2000);
    }
    await toggleBtn.click();
    await page.waitForTimeout(1500);
  }

  // Final full-motion replays
  if (await springBtn.count() > 0) {
    await springBtn.click();
    await page.waitForTimeout(2500);
  }
  if (await staggerBtn.count() > 0) {
    await staggerBtn.click();
    await page.waitForTimeout(2500);
  }
  if (await retargetBtn.count() > 0) {
    await retargetBtn.click();
    await page.waitForTimeout(3000);
  }

  await page.waitForTimeout(2000);

  const videoPath = await page.video()?.path();
  await context.close();

  if (videoPath) {
    const fs = await import('fs');
    const dest = 'C:\\Users\\Daniel\\lab-motion-previews\\showcase-20260820.webm';
    fs.copyFileSync(videoPath, dest);
    console.log('VIDEO_SAVED:' + dest);
  }
});