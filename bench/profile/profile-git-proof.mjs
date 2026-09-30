// PROFILE-01 git-proof: общие git-доказательства provenance для probe и validator.
// Один источник PREREG_OWN_PATHS исключает дрейф allowlist между файлами.
// Fail-closed: любая недоступность git превращается в отказ admission через
// переданный fail-колбэк вызывающей стороны, а не в молчаливый пропуск.

import { execFileSync } from 'node:child_process';
import { readCheckoutState } from '../compare/provenance.mjs';

// Измеряемое дерево обязано совпадать с PRODUCT_BASE везде, кроме самих
// файлов preregistration-пакета. Это позволяет снимать old-vector на
// PR-ветке, выросшей из PRODUCT_BASE, с доказанной эквивалентностью.
export const PREREG_OWN_PATHS = Object.freeze([
  'bench/profile/profile-01-preregistration.mjs',
  'bench/profile/probe-profile-01.mjs',
  'bench/profile/validate-profile-01.mjs',
  'bench/profile/profile-git-proof.mjs',
  'bench/profile/profile-measurement.mjs',
  'test/profile-measurement.test.ts',
  '.github/workflows/profile-01.yml',
]);

export function makeGit(fail) {
  const head = (cwd) => {
    try {
      const state = readCheckoutState(cwd);
      if (state.dirty) fail('измерение требует clean checkout');
      return state.revision;
    } catch {
      fail('git недоступен для доказательства provenance');
    }
  };
  const blob = (cwd, rev, path) => {
    try {
      return execFileSync('git', ['--no-replace-objects', 'rev-parse', `${rev}:${path}`], { cwd, encoding: 'utf8' }).trim();
    } catch {
      fail(`git не смог доказать blob ${path}@${rev}`);
    }
  };
  const workingBlob = (cwd, path) => {
    try {
      return execFileSync('git', ['hash-object', '--', path], { cwd, encoding: 'utf8' }).trim();
    } catch {
      fail(`git не смог доказать рабочий blob ${path}`);
    }
  };
  const diffNames = (cwd, base, headRef) => {
    try {
      const output = execFileSync('git', ['--no-replace-objects', 'diff', '--name-only', `${base}`, `${headRef}`], { cwd, encoding: 'utf8' });
      return output.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      fail(`git не смог доказать эквивалентность дерева ${base}..${headRef}`);
    }
  };
  const ancestor = (cwd, base) => {
    try {
      execFileSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', base, 'HEAD'], { cwd, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  return { head, blob, workingBlob, diffNames, ancestor };
}
