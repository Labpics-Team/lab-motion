import { describe, expect, it } from 'vitest';
import { REDUCED_MOTION_QUERY, reducedMotionMedia } from './helpers/reduced-motion.js';

describe('reduced-motion test oracle', () => {
  it('returns true only for the canonical reduce query', () => {
    const media = reducedMotionMedia(true);

    expect(media(REDUCED_MOTION_QUERY).matches).toBe(true);
    expect(media('(prefers-reduced-motion: no-preference)').matches).toBe(false);
    expect(media('(prefers-color-scheme: dark)').matches).toBe(false);
    expect(media('all').matches).toBe(false);
  });

  it('false policy stays false even for the canonical query', () => {
    expect(reducedMotionMedia(false)(REDUCED_MOTION_QUERY).matches).toBe(false);
  });

  it('records the exact queries observed by production code', () => {
    const queries: string[] = [];
    const media = reducedMotionMedia(true, queries);

    media(REDUCED_MOTION_QUERY);
    media('(width > 1px)');

    expect(queries).toEqual([REDUCED_MOTION_QUERY, '(width > 1px)']);
  });
});
