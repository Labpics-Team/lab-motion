import base from './stryker.config.mjs';

/**
 * Bounded mutation gate for the stateful scrubbable driver.
 *
 * Historical hardening stopped below the repository-wide mutation floor and
 * therefore kept driver.ts outside the scheduled scope. This config turns that
 * debt into an executable gate without making every PR pay for the whole
 * numerical-core campaign.
 */
export default {
  ...base,
  mutate: ['src/driver.ts'],
  vitest: { configFile: 'vitest.stryker.driver.config.ts' },
  htmlReporter: { fileName: 'reports/mutation/driver/index.html' },
  thresholds: { high: 90, low: 80, break: 80 },
};
