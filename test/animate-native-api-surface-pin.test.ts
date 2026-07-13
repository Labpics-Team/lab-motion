import { describe, expect, it } from 'vitest';
import * as native from '../src/animate/native/index.js';

describe('animate/native: публичная поверхность', () => {
  it('экспортирует только capability-specialized springTo', () => {
    expect(Object.keys(native).sort()).toEqual(['springTo']);
  });
});
