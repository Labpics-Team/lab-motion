/**
 * Диагностический бенч компилятора compositor против собранного dist.
 *
 * Меряет разные физические цены отдельно: cold curve, строковый LRU-hit,
 * публичные diagnostics и fan-out production-плана на N детей. Это не CI-гейт:
 * машинно-независимый бюджет работы запечатан тестом compositor-compile-work.
 */

import { performance } from 'node:perf_hooks';
import {
  compileSpringLinear,
} from '../dist/compositor/index.js';
import {
  compileSpringPlan,
  CompositorStaggerGroup,
} from '../dist/compositor/stagger/index.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };
let sink = 0;

function median(values) {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

function measure(label, run, iterations, samples = 9) {
  for (let i = 0; i < Math.min(iterations, 20); i++) sink += run(i);
  const values = [];
  for (let sample = 0; sample < samples; sample++) {
    const offset = sample * iterations;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) sink += run(offset + i);
    values.push(((performance.now() - started) * 1e6) / iterations);
  }
  console.log(`${label.padEnd(36)} ${median(values).toFixed(1).padStart(10)} ns/op`);
}

compileSpringLinear(SPRING);
measure('linear() LRU hit', () => compileSpringLinear(SPRING).length, 100_000);

measure(
  'compileSpringPlan diagnostics warm',
  () => {
    const plan = compileSpringPlan({ spring: SPRING, property: 'x', from: 0, to: 1 });
    return plan.easing.length + plan.nodes.length;
  },
  10_000,
);

// Диапазон каждой выборки уникален и больше LRU: после прогрева все измеряемые
// вызовы — реальные промахи, а не повторное чтение предыдущего sample.
measure(
  'compileSpringPlan cold',
  (i) => {
    const plan = compileSpringPlan({
      spring: { mass: 1, stiffness: 1_000 + i * 0.001, damping: 26 },
      property: 'x',
      from: 0,
      to: 1,
    });
    return plan.easing.length + plan.nodes.length;
  },
  1_000,
);

function target() {
  return {
    animate(keyframes, timing) {
      sink += keyframes.length + timing.duration;
      return { cancel() {} };
    },
  };
}

for (const count of [10, 50, 200]) {
  const targets = Array.from({ length: count }, target);
  measure(
    `group create+start N=${count}`,
    () => {
      const group = new CompositorStaggerGroup({
        spring: SPRING,
        property: 'opacity',
        from: 0,
        to: 1,
        targets,
        gap: 10,
      });
      group.start();
      group.destroy();
      return group.plan.easing.length;
    },
    Math.max(20, Math.floor(1_000 / count)),
  );
}

console.log(`sink=${Number.isFinite(sink) ? 'ok' : 'NaN'}`);
