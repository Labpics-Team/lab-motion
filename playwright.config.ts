/**
 * playwright.config.ts — browser conformance слой (issue #102, фаза D).
 *
 * ЗАЧЕМ: unit/property-сьют (vitest, 2600+ тестов) исполняется в jsdom/node и
 * НЕ видит расхождений реального движка браузера с аналитическими предсказаниями
 * библиотеки (WAAPI-семплирование linear(), CSS.supports, matchMedia,
 * pointer-capture, composed shadow-обход, getComputedStyle-замер FLIP). Этот слой
 * грузит СОБРАННЫЙ dist в реальную страницу трёх движков (Chromium/Firefox/WebKit)
 * и сверяет наблюдаемое поведение с солвером пакета в обоснованном допуске.
 *
 * Детерминизм (критерий приёмки #102 — НЕТ flaky wall-clock assertions):
 *   • WAAPI-семплирование — через Animation.currentTime (pause + явный currentTime),
 *     НЕ sleep+замер. document.timeline — виртуальные часы, воспроизводимо.
 *   • Живые rAF/setTimer-пути ./animate — через инжектируемые швы
 *     (requestFrame/now/setTimer), шаг вручную из теста.
 *   • Стена времени НИКОГДА не входит в ассерты (только как таймаут-страховка).
 *
 * Артефакты (критерий приёмки): trace/video/screenshot ТОЛЬКО при падении.
 *
 * Матрица движков: три проекта. `@playwright/test` пинится точно, поэтому
 * `playwright install` локально и в CI ставит одну ревизию без executablePath-хака.
 * При нужде каталог бинарей задаётся штатным `PLAYWRIGHT_BROWSERS_PATH`.
 * Firefox/WebKit исполняются на CI (`pnpm exec playwright install --with-deps <browser>`);
 * локально гоняется только `--project=chromium` (см. README «Browser support»).
 *
 * testDir = 'browser' — ОТДЕЛЬНО от vitest ('test/'), чтобы vitest не подхватил
 * .spec.ts (и playwright не подхватил vitest .test.ts).
 */

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const PORT = Number(process.env.PW_PORT ?? 6180);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'browser',
  testMatch: /.*\.spec\.ts$/,
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
  webServer: {
    command: `node browser/fixtures/server.mjs ${PORT}`,
    url: `${BASE_URL}/browser/fixtures/harness.html`,
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
