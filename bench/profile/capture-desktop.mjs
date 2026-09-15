import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import { validateDesktopInventory } from './validate.mjs';

const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
const { chromium, firefox, webkit } = compareRequire('playwright');
const playwrightPackage = compareRequire('playwright/package.json');

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function capture(engine, type) {
  const executablePath = type.executablePath();
  const executableSha256 = await sha256File(executablePath);
  const browser = await type.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const pageFacts = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      devicePixelRatio: devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
    }));
    await context.close();
    return {
      engine,
      version: browser.version(),
      playwrightVersion: playwrightPackage.version,
      executableSha256,
      launchMode: 'headless',
      refreshTargetHz: 60,
      ...pageFacts,
    };
  } finally {
    await browser.close();
  }
}

const receipt = {
  schemaVersion: 1,
  profileId: PROFILE_PREREGISTRATION.profileId,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  generatedAt: new Date().toISOString(),
  host: {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    node: process.version,
    cpus: os.cpus().length,
  },
  browsers: [
    await capture('chromium', chromium),
    await capture('firefox', firefox),
    await capture('webkit', webkit),
  ],
};

validateDesktopInventory(receipt);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
