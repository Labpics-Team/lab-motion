import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.DOCS_PORT ?? 6181);
const baseURL = `http://127.0.0.1:${port}${process.env.DOCS_BASE ?? '/'}`;

export default defineConfig({
  testDir: './test',
  outputDir: '../../test-results/docs',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `pnpm docs:preview --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: `${baseURL}getting-started.html`,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } },
  ],
});
