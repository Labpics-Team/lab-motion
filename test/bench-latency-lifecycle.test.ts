import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CompositorSpring } from '../src/compositor/index.js';
import {
  createCompositorHandoffLatencyScenario,
  measureCompositorHandoffLatency,
  measureLatency,
} from '../scripts/bench-latency-support.mjs';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function createScenario() {
  return createCompositorHandoffLatencyScenario({
    CompositorSpring,
    spring: SPRING,
    property: 'x',
    from: 0,
    to: 100,
    initialNow: 1_000,
    elapsedMs: 16,
  });
}

describe('жизненный цикл latency-стенда handoff', () => {
  it('исполняет CLI-entrypoint с одним op внутри измеряемого окна', () => {
    const phases: string[] = [];
    let nowNs = 0n;
    const result = measureCompositorHandoffLatency({
      CompositorSpring,
      spring: SPRING,
      property: 'x',
      from: 0,
      to: 100,
      initialNow: 1_000,
      elapsedMs: 16,
      nowNs() {
        phases.push('clock');
        nowNs += 100n;
        return nowNs;
      },
      onPhase(phase: string) {
        phases.push(phase);
      },
      warmup: 1,
      iters: 2,
      runs: 1,
    });

    expect(result).toEqual({
      label: 'CompositorSpring.handoffToLive (read+cancel+build)',
      p50: 100,
      p95: 100,
      p99: 100,
    });
    expect(phases).toEqual([
      'setup', 'op', 'verify', 'teardown',
      'setup', 'clock', 'op', 'clock', 'verify', 'teardown',
      'setup', 'clock', 'op', 'clock', 'verify', 'teardown',
    ]);
  });

  it('отвергает прежний setup с повторным использованием controller', () => {
    const scenario = createScenario();
    const reusedSample = scenario.setup(0);

    expect(() => measureLatency('handoff', {
      ...scenario,
      setup: () => reusedSample,
      nowNs: (() => {
        let value = 0n;
        return () => ++value;
      })(),
      warmup: 1,
      iters: 1,
      runs: 1,
    })).toThrow(/повторно использован/i);
  });

  it('регистрирует CLI handoff только через проверяемый entrypoint', () => {
    const script = readFileSync('scripts/bench-latency.mjs', 'utf8');
    const start = script.indexOf('// ── D.');
    const end = script.indexOf('// ── E.');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const registration = script.slice(start, end);

    expect([...registration.matchAll(/measureCompositorHandoffLatency\(/g)]).toHaveLength(1);
    expect(registration).not.toMatch(
      /new CompositorSpring|\.handoffToLive\(|\b(?:setup|op|verify|teardown)\s*:/,
    );
  });

  it('отвергает пустые размеры и полностью замороженные часы', () => {
    const constantNow = () => 0n;
    expect(() => measureLatency('invalid', {
      op() {},
      nowNs: constantNow,
      warmup: 0,
      iters: 0,
      runs: 1,
    })).toThrow(/iters/);
    expect(() => measureLatency('invalid', {
      op() {},
      nowNs: constantNow,
      warmup: 0,
      iters: 1,
      runs: 0,
    })).toThrow(/runs/);
    expect(() => measureLatency('invalid', {
      op() {},
      nowNs: constantNow,
      warmup: -1,
      iters: 1,
      runs: 1,
    })).toThrow(/warmup/);
    expect(() => measureLatency('invalid', {
      op() {},
      nowNs: constantNow,
      warmup: 0,
      iters: 2,
      runs: 1,
    })).toThrow(/положительн/i);
  });

  it('сохраняет нулевой sample, если часы различили хотя бы одну операцию', () => {
    const timestamps = [0n, 0n, 0n, 7n];
    let index = 0;
    expect(measureLatency('quantized', {
      op() {},
      nowNs: () => timestamps[index++]!,
      warmup: 0,
      iters: 2,
      runs: 1,
    })).toEqual({ label: 'quantized', p50: 0, p95: 7, p99: 7 });
  });
});
