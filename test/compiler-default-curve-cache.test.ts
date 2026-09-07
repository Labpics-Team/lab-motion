import { describe, expect, it, vi } from 'vitest';

const work = vi.hoisted(() => ({ builds: 0 }));

vi.mock('../src/nano/spring-linear.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nano/spring-linear.js')>();
  return {
    ...actual,
    springLinear(...args: Parameters<typeof actual.springLinear>) {
      work.builds++;
      return actual.springLinear(...args);
    },
  };
});

import { compileNanoOpacityArtifact } from '../src/compiler/core.js';
import { springLinear } from '../src/nano/spring-linear.js';

describe('compiler: default nano spring build cache', () => {
  it('builds the target-invariant default spring curve once across opacity artifacts', () => {
    const before = work.builds;

    const first = compileNanoOpacityArtifact(0.25);
    const second = compileNanoOpacityArtifact(0.5);
    const third = compileNanoOpacityArtifact(0.75);

    expect(work.builds - before).toBe(1);
    expect(first.durationMs).toBe(second.durationMs);
    expect(second.durationMs).toBe(third.durationMs);
    expect(first.cssLinear).toBe(second.cssLinear);
    expect(second.cssLinear).toBe(third.cssLinear);
    expect(first.frame.opacity).toBe(0.25);
    expect(second.frame.opacity).toBe(0.5);
    expect(third.frame.opacity).toBe(0.75);

    // Positive control: the mock still observes an uncached direct curve build.
    const afterCompiler = work.builds;
    springLinear();
    expect(work.builds - afterCompiler).toBe(1);
  });
});
