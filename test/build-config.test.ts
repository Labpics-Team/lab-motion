import { describe, expect, it } from 'vitest';
import config from '../tsup.config.js';

describe('build config: изоляция Terser', () => {
  it('каждое чтение выдаёт свежие nested options параллельному minify', () => {
    const options = Array.isArray(config) ? config[0] : config;
    const terser = (options as {
      terserOptions?: {
        compress?: unknown;
        mangle?: { properties?: unknown };
      };
    }).terserOptions!;

    const firstCompress = terser.compress;
    const secondCompress = terser.compress;
    expect(firstCompress).not.toBe(secondCompress);
    expect(firstCompress).toEqual({ passes: 3, pure_getters: true });
    expect(secondCompress).toEqual(firstCompress);
    const firstMangle = terser.mangle!;
    const secondMangle = terser.mangle!;
    expect(firstMangle).not.toBe(secondMangle);
    expect(firstMangle.properties).not.toBe(secondMangle.properties);
    expect(firstMangle).toEqual({ properties: { regex: /^_/ } });
    expect(secondMangle).toEqual(firstMangle);
  });
});
