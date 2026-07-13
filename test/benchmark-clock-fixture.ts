export const TIMER_ORIGIN_MS = 1_000_000_000_000;

export const timerEvidence = (quantumMs = 0.1) => ({
  crossOriginIsolated: true,
  probes: ['before', 'after'].map((phase) => ({
    phase,
    timeOriginMs: TIMER_ORIGIN_MS,
    performanceNowDeltasMs: Array.from({ length: 16 }, () => quantumMs),
  })),
});

export const startClock = () => ({
  token: 'start-clock',
  cdpToken: 'start-clock',
  cdpClockDomain: 'TimeSinceEpoch',
  runtimeTimestampUnit: 'milliseconds',
  frameTimestampUnit: 'seconds',
  pageTimeOriginMs: TIMER_ORIGIN_MS,
  pageBeforeNowMs: 10,
  pageApiNowMs: 10.02,
  cdpRuntimeTimestampMs: TIMER_ORIGIN_MS + 10.01,
});
