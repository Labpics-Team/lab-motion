/** Real-browser coverage for the built library and its consumer fixtures. */

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const PORT = Number(process.env.PW_PORT ?? 6180);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'browser',
  testMatch: /.*\.spec\.ts$/,
  // Собирает compiled/uncompiled fixture-бандлы для 17-compiler-nano.spec один
  // раз до прогона (реальный Vite + плагин, alias на dist). Прочие спеки грузят
  // dist напрямую и этот шаг игнорируют.
  globalSetup: './browser/fixtures/compile-artifacts.mjs',
  // Страховочный таймаут — НЕ ассерт: детерминированные пути осёдают за микросекунды.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: isCI,
  // Ретраи только на CI: на общих раннерах гасят инфраструктурный шум, не давая
  // маскировать flaky-логику (её у детерминированных ассертов нет по построению).
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: BASE_URL,
    // Артефакты только on-failure (критерий приёмки #102).
    trace: 'retain-on-failure',
    // Видео требует ffmpeg (есть на CI после `playwright install --with-deps`);
    // локально в dev-среде его может не быть — trace/screenshot достаточно для
    // диагностики, поэтому видео включаем только на CI (там оно on-failure).
    video: isCI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },

  // Zero-dep статический сервер отдаёт repo-root по http — модульные import из
  // dist резолвятся по origin (file:// упёрлось бы в module-CORS Chromium).
  // Readiness follows the library artifact consumed by this suite.
  webServer: {
    command: `node browser/fixtures/server.mjs ${PORT}`,
    url: `${BASE_URL}/dist/index.js`,
    // Не переиспользуем уже поднятый сервер по умолчанию: чужой checkout мог бы
    // отдавать ДРУГОЙ dist по тому же URL и молча исказить результат. Опт-ин
    // PW_REUSE_SERVER=1 для локального итеративного цикла.
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        // Матрица проверяет только локальный fixture-server. Системный proxy
        // macOS может вернуть для loopback 502 и не дать запустить ни один
        // сценарий, поэтому Firefox здесь всегда ходит напрямую.
        launchOptions: { firefoxUserPrefs: { 'network.proxy.type': 0 } },
      },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
