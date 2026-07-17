/** Consumer ловит domain error constructor-ом из того же физического entry. */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('./in-view dist boundary', () => {
  it('ESM экспортирует локальный constructor, не меняя root contract', () => {
    const root = resolve(import.meta.dirname, '..');
    const script = [
      "import { MotionParamError as RootMotionParamError } from './dist/index.js';",
      "import { inView, MotionParamError } from './dist/in-view/index.js';",
      "const rootError = new RootMotionParamError('not-a-code');",
      'try { inView({ nodeType: 1 }, () => undefined); }',
      'catch (error) {',
      '  console.log(JSON.stringify({',
      '    code: error.code,',
      '    identity: error instanceof MotionParamError,',
      '    rootIdentity: rootError instanceof RootMotionParamError,',
      '    rootCode: rootError.code,',
      '    constructorsShared: MotionParamError === RootMotionParamError,',
      '  }));',
      '}',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      code: 'LM147',
      identity: true,
      rootIdentity: true,
      rootCode: 'LM000',
      constructorsShared: false,
    });
  });

  it('CJS экспортирует constructor из того же bundled entry', () => {
    const root = resolve(import.meta.dirname, '..');
    const script = [
      "const { MotionParamError: RootMotionParamError } = require('./dist/index.cjs');",
      "const { inView, MotionParamError } = require('./dist/in-view/index.cjs');",
      'try { inView({ nodeType: 1 }, () => undefined); }',
      'catch (error) {',
      '  console.log(JSON.stringify({',
      '    code: error.code,',
      '    identity: error instanceof MotionParamError,',
      '    constructorsShared: MotionParamError === RootMotionParamError,',
      '  }));',
      '}',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=commonjs', '--eval', script], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      code: 'LM147',
      identity: true,
      constructorsShared: false,
    });
  });
});
