import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReplayedVector } from '../bench/profile/profile-measurement.mjs';
import { PROFILE_01, unmeasuredCells, verifyPreregistration } from '../bench/profile/profile-01-preregistration.mjs';
import { makeGit } from '../bench/profile/profile-git-proof.mjs';

describe('PROFILE: происхождение подтверждает настоящий Git', () => {
  it('различает clean, tracked/untracked drift, ancestry и недоступное доказательство', () => {
    const directory = mkdtempSync(join(tmpdir(), 'motion-profile-git-'));
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }).trim();
    const proof = makeGit((message: string) => { throw new Error(message); });
    try {
      git('init', '--quiet');
      git('config', 'core.autocrlf', 'false');
      git('config', 'core.hooksPath', join(directory, 'no-hooks'));
      const commit = () => {
        git('add', '.');
        git('-c', 'user.name=PROFILE test', '-c', 'user.email=profile@example.invalid', '-c', 'commit.gpgsign=false',
          'commit', '--quiet', '-m', 'fixture');
        return git('rev-parse', 'HEAD');
      };
      writeFileSync(join(directory, 'source.txt'), 'first\n');
      const base = commit();
      expect(proof.head(directory)).toBe(base);
      const originalBlob = createHash('sha1').update('blob 6\0first\n').digest('hex');
      expect(proof.blob(directory, base, 'source.txt')).toBe(originalBlob);
      expect(proof.workingBlob(directory, 'source.txt')).toBe(originalBlob);
      writeFileSync(join(directory, 'source.txt'), 'second\n');
      expect(() => proof.head(directory)).toThrow();
      expect(proof.workingBlob(directory, 'source.txt')).not.toBe(originalBlob);
      const head = commit();
      expect(proof.head(directory)).toBe(head);
      expect(proof.diffNames(directory, base, head)).toEqual(['source.txt']);
      expect(proof.ancestor(directory, base)).toBe(true);
      git('checkout', '--quiet', '--detach', base);
      expect(proof.ancestor(directory, head)).toBe(false);
      writeFileSync(join(directory, 'untracked.txt'), 'drift\n');
      expect(() => proof.head(directory)).toThrow();
      expect(() => proof.blob(directory, base, 'missing.txt')).toThrow();
      expect(() => proof.workingBlob(directory, 'missing.txt')).toThrow();
      expect(() => proof.diffNames(directory, 'missing-revision', head)).toThrow();
      expect(() => proof.head(join(directory, 'missing-directory'))).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('old-vector сохраняет отказ измерения, когда в clean clone нет инструментов', () => {
    const directory = mkdtempSync(join(tmpdir(), 'motion-profile-missing-tools-'));
    try {
      const root = fileURLToPath(new URL('../', import.meta.url));
      const clone = join(directory, 'checkout');
      const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', root, clone],
        { encoding: 'utf8', timeout: 30_000 });
      execFileSync('git', ['checkout', '--quiet', '--detach', sourceHead], { cwd: clone, timeout: 30_000 });
      const run = spawnSync(process.execPath, [
        'bench/profile/probe-profile-01.mjs', '--mode', 'old-vector', '--cells', 'all',
        '--out', join(directory, 'raw'),
      ], { cwd: clone, encoding: 'utf8', timeout: 30_000 });
      expect(run.status, run.stderr).toBe(1);
      const receipt = JSON.parse(run.stdout.trim());
      const raw = readFileSync(receipt.rawPath);
      const artifact = JSON.parse(raw.toString('utf8'));
      expect(artifact.head).toBe(sourceHead);
      expect(artifact.admission).toBe('NOT-GRANTED');
      expect(artifact.rejection).toContain('незавершённое измерение');
      expect(artifact.rejection).toMatch(/не установлен|не создала обязательный|сборка/);
      expect(artifact.costVector).toBeNull();
      expect(artifact.cellsMeasured).toEqual([]);
      expect(artifact.cellsUnproven).toEqual(unmeasuredCells('all'));
      expect(receipt.rawDigest).toBe(createHash('sha256').update(raw).digest('hex'));
      const refusal = spawnSync(process.execPath, ['bench/profile/validate-profile-01.mjs', '--raw', receipt.rawPath],
        { cwd: clone, encoding: 'utf8', timeout: 30_000 });
      expect(refusal.status, refusal.stderr).toBe(0);
      expect(JSON.parse(refusal.stdout.trim()).verification).toBe('recorded-refusal-only');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('PROFILE: замороженный протокол проверяется целиком', () => {
  it('зарегистрированные потолки совпадают с единственным исполняемым size-gate', async () => {
    const gate = await import('../scripts/size-gate.mjs');
    const registered = PROFILE_01.oldCostVectorGzipBytes;
    expect(registered.bespoke).toEqual(gate.BESPOKE_SUBPATH_GATES);
    expect(registered.scenarios).toEqual(Object.fromEntries(
      gate.IMPORT_COST_SCENARIOS.map(({ name, gate: ceiling }) => [name, ceiling]),
    ));
    expect(registered.core).toBe(gate.CORE_GATE_BYTES);
    expect(registered.subpath).toBe(gate.SUBPATH_GATE_BYTES);
    expect(registered.fullCoreConsumer).toBe(gate.FULL_CORE_CONSUMER_GATE_BYTES);
    expect(registered.nano).toBe(gate.NANO_GATE_BYTES);
    expect(registered.compiledRuntime).toBe(gate.BESPOKE_SUBPATH_GATES['./compiler/runtime']);
    expect(registered.compilerSurface).toBe(gate.BESPOKE_SUBPATH_GATES['./compiler/surface']);
    expect(registered.inView).toBe(gate.IN_VIEW_GATE_BYTES);
    expect(registered.inViewConsumer).toBe(gate.IN_VIEW_CONSUMER_GATE_BYTES);
    expect(registered.compositorCapability).toBe(gate.COMPOSITOR_CAPABILITY_GATE_BYTES);
    expect(registered.fullAnimate).toBe(gate.FULL_ANIMATE_GATE_BYTES);
    expect(registered.animateCompositorMixed).toBe(gate.ANIMATE_COMPOSITOR_MIXED_GATE_BYTES);
  });

  it('принимает независимую JSON-копию полного протокола', () => {
    expect(verifyPreregistration()).toBe(true);
    expect(verifyPreregistration(JSON.parse(JSON.stringify(PROFILE_01)))).toBe(true);
  });

  it.each([
    ['productBase', 'reason'], ['scenes', 'm05a', 'acceptance'],
    ['rawControls', 'aa'], ['statsMde', 'sampleSize'], ['calibration', 'failClosed'],
  ])('отвергает подмену условия %s.%s', (...path) => {
    const changed = JSON.parse(JSON.stringify(PROFILE_01));
    const parent = path.slice(0, -1).reduce((object, key) => object[key], changed);
    parent[path.at(-1)!] = 'условие удалено';
    expect(() => verifyPreregistration(changed)).toThrow();
  });

  it('отвергает потерю, подмену и лишние поля на каждой глубине', () => {
    function visit(value: unknown, path: string[] = []) {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = [...path, key];
        for (const operation of ['delete', 'replace']) {
          const changed = JSON.parse(JSON.stringify(PROFILE_01));
          const parent = path.reduce((object, segment) => object[segment], changed);
          if (operation === 'delete') delete parent[key];
          else parent[key] = typeof child === 'string' ? `${child}!` : 'другой тип';
          expect(() => verifyPreregistration(changed), `${operation} ${childPath.join('.')}`).toThrow();
        }
        visit(child, childPath);
      }
      const extra = JSON.parse(JSON.stringify(PROFILE_01));
      const parent = path.reduce((object, key) => object[key], extra);
      parent.unregistered = true;
      expect(() => verifyPreregistration(extra), `extra ${path.join('.')}`).toThrow();
    }
    visit(PROFILE_01);
    for (const invalid of [null, [], '', 1, true]) {
      expect(() => verifyPreregistration(invalid)).toThrow();
    }
  });

  it('не позволяет мутировать вложенные массивы исходного протокола', () => {
    expect(() => PROFILE_01.roster.classes[0].browsers.push('подмена')).toThrow();
    expect(PROFILE_01.roster.classes[0].browsers).toEqual(['chromium-webview-stable']);
  });
});

function measured() {
  return {
    exitCode: 0,
    entries: { rows: [{ label: '.', gzBytes: 42, gate: 100 }], hasWarnings: false },
    scenarios: [{ name: 'only-spring', gzBytes: 7, totalGzBytes: 7, gate: 10 }],
    provenance: {
      revision: 'a'.repeat(40), trackedRevisionSha256: 'b'.repeat(64),
      inputs: { 'root/pnpm-lock.yaml': 'c'.repeat(64) },
      distRuntime: { sha256: 'd'.repeat(64), files: 2 },
      environment: { node: 'v24.15.0', pnpm: '11.11.0' },
      builtAt: '2026-09-30T00:00:00Z',
    },
  };
}

describe('PROFILE: записанный успех не заменяет независимый результат', () => {
  it('принимает воспроизведённые данные с новым временем сборки', () => {
    const replayed = measured();
    replayed.provenance.builtAt = '2026-09-30T00:01:00Z';
    expect(() => validateReplayedVector(measured(), replayed)).not.toThrow();
  });

  it('отвергает старую подделку из имён сценариев и exit 0', () => {
    const forged = { exitCode: 0, transcript: 'only-spring size-gate: PASS' };
    expect(() => validateReplayedVector(forged, measured())).toThrow('структурированные измерения');
  });

  it('отвергает отказ повторного измерения при записанном успехе', () => {
    expect(() => validateReplayedVector(measured(), { ...measured(), exitCode: 1 })).toThrow('независимое измерение');
  });

  it('не повышает сохранённый отказ до успеха', () => {
    expect(() => validateReplayedVector({ ...measured(), exitCode: 1 }, measured())).toThrow('независимое измерение');
  });

  it('ловит подмену числа при сохранённом PASS и неизменных названиях', () => {
    const forged = measured();
    forged.scenarios[0].gzBytes = 1;
    expect(() => validateReplayedVector(forged, measured())).toThrow('scenarios');
  });

  it('ловит удалённый consumer и лишний неподтверждённый entry', () => {
    const missing = measured();
    missing.scenarios = [];
    expect(() => validateReplayedVector(missing, measured())).toThrow();
    const extra = measured();
    extra.entries.rows.push({ label: './extra', gzBytes: 1, gate: 100 });
    expect(() => validateReplayedVector(extra, measured())).toThrow('entries');
  });

  it.each(['revision', 'trackedRevisionSha256', 'inputs', 'distRuntime', 'environment'])('отвергает другой %s', (field) => {
    const forged = measured();
    Reflect.set(forged.provenance, field, 'forged');
    expect(() => validateReplayedVector(forged, measured())).toThrow(`provenance.${field}`);
  });

  it('размерный прогон оставляет все device/timing клетки непроверенными', () => {
    expect(unmeasuredCells('desktop').map((row: { cell: string }) => row.cell)).toEqual([
      'desktop-chromium', 'desktop-firefox', 'desktop-webkit', 'whole-page energy/GPU',
    ]);
    expect(unmeasuredCells('all').map((row: { cell: string }) => row.cell)).toEqual([
      'android-mid-60', 'android-mid-120', 'ios-60', 'ios-120',
      'desktop-chromium', 'desktop-firefox', 'desktop-webkit', 'whole-page energy/GPU',
    ]);
    expect(() => unmeasuredCells('unknown')).toThrow();
  });

  it('хеш реального failure-артефакта покрывает отступы, Unicode и конечный LF', () => {
    const directory = mkdtempSync(join(tmpdir(), 'motion-profile-digest-'));
    try {
      const root = fileURLToPath(new URL('../', import.meta.url));
      const run = spawnSync(process.execPath, [
        'bench/profile/probe-profile-01.mjs', '--mode', 'aa', '--out', directory,
      ], { cwd: root, encoding: 'utf8', timeout: 15_000 });
      expect(run.status, run.stderr).toBe(1);
      const receipt = JSON.parse(run.stdout.trim());
      const raw = readFileSync(receipt.rawPath);
      expect(JSON.parse(raw.toString('utf8')).rejection).toContain('browser-калибровки');
      expect(raw.toString('utf8')).toContain('\n  "node"');
      expect(raw.at(-1)).toBe(10);
      expect(receipt.rawDigest).toBe(createHash('sha256').update(raw).digest('hex'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
