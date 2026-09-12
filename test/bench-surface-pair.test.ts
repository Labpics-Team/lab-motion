import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  consumeSurface,
  executeSurfaceBurst,
  pairedSurfaceOrder,
  runSurfaceCluster,
  surfaceBurstVerifier,
  surfaceCalibrationAdmitted,
  surfaceClusterEvidence,
  summarizeSurfacePair,
  surfaceCode,
  surfaceInputs,
  surfaceProbeSource,
  surfaceProfiles,
  surfaceVerdict,
  SURFACE_CALIBRATION_IDS,
  SURFACE_PAIR_POLICY,
} from '../scripts/bench-surface-support.mjs';
import { sha256File } from '../bench/compare/provenance.mjs';
import { parseSurfaceBenchArgs, replaySurfaceReport } from '../scripts/bench-surface-pair.mjs';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function record(cluster = 0, calls = 32) {
  return {
    cluster, profile: 'ordinary/warm/consume', semantic: true, sink: 42,
    warmupBursts: SURFACE_PAIR_POLICY.warmupBursts, multipliers: [1, 1],
    samples: pairedSurfaceOrder(cluster).map((side: number) => ({ side, calls, elapsedNs: 1000 * calls, ns: 1000 })),
  };
}

function equality() {
  return { semantic: true, p50: { low: 0.99, high: 1.01, ratio: 1 }, p95: { low: 0.98, high: 1.04, ratio: 1 } };
}
const positive = () => ({ semantic: true, p50: { low: 1.9, high: 2.1, ratio: 2 }, p95: { low: 1.8, high: 2.2, ratio: 2 } });

describe('Surface: публичная топология и полный потребитель результата', () => {
  it('хранит один manifest; cache-miss не имитируется сбросом кэша', () => {
    const profiles = surfaceProfiles();
    expect(profiles).toHaveLength(32);
    expect(new Set(profiles.map((p: { id: string }) => p.id)).size).toBe(32);
    const profile = profiles.find((p: { id: string }) => p.id === 'ordinary/miss/consume');
    const inputs = surfaceInputs(profile);
    expect(inputs).toHaveLength(512);
    expect(new Set(inputs).size).toBe(512);
    expect(inputs).toEqual(surfaceInputs(profile));
    expect(surfaceInputs({ ...profile, cache: 'warm' })).toHaveLength(1);
    expect(() => surfaceInputs({ ...profile, cache: 'clear' })).toThrow();
    expect(() => surfaceCode('not-a-case')).toThrow();
    expect(() => surfaceCode('ordinary', Infinity)).toThrow();
    expect((surfaceCode('batch').match(/animate\(el\d/g) ?? []).length).toBe(8);
    expect(surfaceCode('reject')).toContain('[1,100000]');
    expect(SURFACE_CALIBRATION_IDS.every((id: string) => profiles.some((p: { id: string }) => p.id === id))).toBe(true);
  });

  it('прочитывает code, mappings и все текстовые поля карты, не только length', () => {
    const result = { code: 'abc', map: { mappings: 'AAAA', sources: ['x'], sourcesContent: ['y'], names: ['z'] } };
    const modified = structuredClone(result);
    modified.map.names[0] = 'q';
    expect(consumeSurface(result, false)).toBe(7);
    expect(consumeSurface(modified, false)).toBe(7);
    expect(consumeSurface(result, true)).not.toBe(consumeSurface(modified, true));
    expect(consumeSurface(undefined, true)).toBe(1);
    const expected = 7 + [...'abcAAAAxyz'].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    expect(consumeSurface(result, true)).toBe(expected);
  });

  it('не переписывает dist и сохраняет nested IIFE вместо извлечения приватной функции', () => {
    const source = 'function m(){return(function(){return{reciprocalEasing:"x"}})()}export{m as motionCompiler};';
    expect(surfaceProbeSource(source, ts)).toBe(source);
    expect(surfaceProbeSource('export function motionCompiler() {}', ts)).toBe('export function motionCompiler() {}');
    for (const bad of [
      'const motionCompiler = 1;',
      'export function motionCompiler( {',
      'import x from "./runtime.js";export function motionCompiler(){}',
      'export {motionCompiler} from "./other.js";',
      'export function motionCompiler(){return import("./late.js")}',
    ]) expect(() => surfaceProbeSource(bad, ts)).toThrow();
  });

  it('одинаковые bytes получают две независимые module identities, как A/B', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'motion-surface-identities-'));
    temporary.push(directory);
    const source = 'let count=0;export function motionCompiler(){return ++count}';
    const files = ['base.mjs', 'equal.mjs'].map(name => path.join(directory, name));
    for (const file of files) writeFileSync(file, surfaceProbeSource(source, ts));
    expect(readFileSync(files[0]!, 'utf8')).toBe(readFileSync(files[1]!, 'utf8'));
    const first = await import(/* @vite-ignore */ pathToFileURL(files[0]!).href);
    const second = await import(/* @vite-ignore */ pathToFileURL(files[1]!).href);
    expect(first.motionCompiler()).toBe(1);
    expect(first.motionCompiler()).toBe(2);
    expect(second.motionCompiler()).toBe(1);
    expect(first.motionCompiler).not.toBe(second.motionCompiler);
  });
});

describe('Surface: один batch call-site, виртуальный clock, реальные positive controls', () => {
  it.each([0, 1])('прогрев и timed bursts исполняют объявленные вызовы в cluster %i', cluster => {
    const calls = [0, 0];
    const values = [2, 3];
    const clockCalls: number[] = [];
    let clock = 0n;
    const now = () => { clockCalls.push(calls[0]! + calls[1]!); clock += 100n; return clock; };
    const result = runSurfaceCluster([
      () => { calls[0]!++; return values[0]; },
      () => { calls[1]!++; return values[1]; },
    ], { id: 'virtual', calls: 2 }, cluster, {
      now, warmupBursts: 3, verify: surfaceBurstVerifier([[2], [3]]),
    });
    expect(calls).toEqual([10, 10]);
    expect(clockCalls[0]).toBe(12); // Ничего из прогрева не попало в timed-window.
    expect(result.samples.map((s: { side: number }) => s.side)).toEqual(pairedSurfaceOrder(cluster));
    expect(result.samples.every((s: { ns: number }) => s.ns === 50)).toBe(true);
    expect(result.sink).toBe(50);
    expect(result.semantic).toBe(true);
    expect(executeSurfaceBurst(() => 7, 3)).toBe(21);
  });

  it('одна физическая граница вызова принадлежит и прогреву, и замеру', () => {
    const parents: (string | undefined)[] = [];
    const capture = () => {
      parents.push(new Error().stack?.split('\n').find(line => /at (?:Module\.)?executeSurfaceBurst \(/.test(line)));
      return 1;
    };
    let time = 0n;
    runSurfaceCluster([capture, capture], { id: 'call-site', calls: 2 }, 0, {
      warmupBursts: 2, now: () => ++time, verify: surfaceBurstVerifier([[1], [1]]),
    });
    expect(parents).toHaveLength(16);
    expect(parents.every(Boolean)).toBe(true);
    expect(new Set(parents).size).toBe(1);
    // Positive control: одинаковая операция вне batch не имеет этого owner.
    capture();
    expect(parents.at(-1)).toBeUndefined();
  });

  it('two-call control удваивает работу, но не знаменатель per-request метрики', () => {
    let time = 0n;
    const operation = () => { time += 10n; return 1; };
    const result = runSurfaceCluster([operation, operation], { id: 'double', calls: 3 }, 0, {
      now: () => time, warmupBursts: 1, multipliers: [1, 2], verify: surfaceBurstVerifier([[1], [1]]),
    });
    expect(result.samples.map((s: { ns: number }) => s.ns)).toEqual([10, 20, 20, 10]);
    expect(result.samples.map((s: { calls: number }) => s.calls)).toEqual([3, 6, 6, 3]);
  });

  it('реально ловит lost-call / changed-output и учитывает циклические входы', () => {
    const verify = surfaceBurstVerifier([[1, 2, 3], [4]]);
    verify(0, 6, 3);
    verify(0, 3, 2);
    verify(0, 4, 2);
    expect(() => verify(1, 0, 1)).toThrow('изменился результат');
    expect(() => surfaceBurstVerifier([[NaN], [1]])).toThrow();
    expect(() => surfaceBurstVerifier([new Array(2), [1]])).toThrow();
    expect(() => runSurfaceCluster([() => 1, () => 1], { id: 'lost', calls: 2 }, 0, {
      now: () => 0n, warmupBursts: 1,
    })).toThrow('потерян sample');
    expect(() => runSurfaceCluster([() => NaN, () => 1], { id: 'lost', calls: 2 }, 0, {
      warmupBursts: 1,
    })).toThrow();
  });
});

describe('Surface: отсутствие доказательства не становится зелёным отчётом', () => {
  it('группирует только полные сбалансированные независимые кластеры', () => {
    const profile = { id: 'ordinary/warm/consume', calls: 32 };
    const raw = [record(0), record(1)];
    const before = structuredClone(raw);
    const result = surfaceClusterEvidence(raw, profile, 2);
    expect(result.map((side: { samples: number[] }[]) => side.map(row => row.samples))).toEqual([
      [[1000, 1000], [1000, 1000]], [[1000, 1000], [1000, 1000]],
    ]);
    expect(raw).toEqual(before);
    for (const mutation of [
      (r: ReturnType<typeof record>[]) => { r.pop(); },
      (r: ReturnType<typeof record>[]) => { r[1]!.cluster = 0; },
      (r: ReturnType<typeof record>[]) => { r[0]!.samples[1]!.side = 0; },
      (r: ReturnType<typeof record>[]) => { r[0]!.samples[0]!.elapsedNs = NaN; },
      (r: ReturnType<typeof record>[]) => { r[0]!.samples[0]!.ns *= 2; },
      (r: ReturnType<typeof record>[]) => { r[0]!.samples[0]!.calls++; },
      (r: ReturnType<typeof record>[]) => { r[0]!.semantic = false; },
      (r: ReturnType<typeof record>[]) => { r[0]!.warmupBursts--; },
    ]) {
      const broken = structuredClone(raw);
      mutation(broken);
      expect(() => surfaceClusterEvidence(broken, profile, 2)).toThrow();
    }
  });

  it('требует все A/A и positive: sparse/NaN/wide-tail не проходят', () => {
    const rows = Array.from({ length: 4 }, equality);
    expect(surfaceCalibrationAdmitted(rows, positive())).toBe(true);
    expect(surfaceCalibrationAdmitted(new Array(4), positive())).toBe(false);
    expect(surfaceCalibrationAdmitted(rows.slice(1), positive())).toBe(false);
    expect(surfaceCalibrationAdmitted(rows, equality())).toBe(false);
    for (const bad of [
      { ...equality(), semantic: false },
      { ...equality(), p95: { low: 0.98, high: 1.051, ratio: 1 } },
      { ...equality(), p95: { low: 0.7, high: 0.9, ratio: 0.8 } },
      { ...equality(), p50: { low: NaN, high: 1.01, ratio: 1 } },
    ]) expect(surfaceCalibrationAdmitted([bad, ...rows.slice(1)], positive())).toBe(false);
  });

  it('запрещает candidate timing до калибровки и неполное admission', () => {
    const rows = surfaceProfiles().map((p: { id: string }) => ({ profile: p.id, comparison: 'candidate', stats: equality() }));
    expect(surfaceVerdict(rows, true, false).status).toBe('LATENCY_ADMISSION');
    expect(() => surfaceVerdict(rows, false, false)).toThrow();
    expect(() => surfaceVerdict(rows.slice(1), true, false)).toThrow();
    expect(surfaceVerdict([], false, false).status).toBe('UNPROVEN');
    expect(surfaceVerdict([], true, true).status).toBe('CALIBRATED');
    rows[0]!.stats.p95.high = NaN;
    expect(() => surfaceVerdict(rows, true, false)).toThrow('неполная статистика');
    rows[0]!.stats.p95.high = 1.2;
    expect(surfaceVerdict(rows, true, false).unresolved).toEqual([rows[0]!.profile]);
  });

  it('CLI не принимает дубликаты, runtime knobs или неоднозначную калибровку', () => {
    expect(parseSurfaceBenchArgs(['--base', '.', '--candidate', '..', '--out', '/tmp/new'])).toEqual({
      base: path.resolve('.'), candidate: path.resolve('..'), out: '/tmp/new',
    });
    expect(parseSurfaceBenchArgs(['--base', '.', '--out', '/tmp/new', '--calibrate-only']).calibrateOnly).toBe(true);
    for (const args of [
      [], ['--base'], ['--out', '--base'], ['--iterations', '100000'],
      ['--base', '.', '--base', '..'],
      ['--base', '.', '--candidate', '..', '--out', '/tmp/new', '--calibrate-only'],
    ]) expect(() => parseSurfaceBenchArgs(args)).toThrow();
  });
});


describe('Surface: process boundary и raw readback', () => {
  it('настоящий worker исполняет протокол и ловит подмену bytes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'motion-surface-worker-'));
    temporary.push(directory);
    const source = `export function motionCompiler(){return {transform(code){return {
      code:'__labMotionSurface'+code,map:{mappings:'AAAA',sources:['consumer.js'],sourcesContent:[code],names:[]}
    }}}}`;
    const base = path.join(directory, 'base.mjs');
    const equal = path.join(directory, 'equal.mjs');
    const parser = path.join(directory, 'parser.mjs');
    const manifestPath = path.join(directory, 'manifest.json');
    writeFileSync(base, source);
    writeFileSync(equal, source);
    writeFileSync(parser, 'export function parse(){throw Error("fixture не должен парсить")};');
    writeFileSync(manifestPath, JSON.stringify({
      policy: SURFACE_PAIR_POLICY, nodeExecutable: sha256File(process.execPath),
      probes: { base, equal }, acorn: { module: parser },
      probeHashes: { base: { path: base, sha256: sha256File(base) }, equal: { path: equal, sha256: sha256File(equal) } },
    }));
    const command = [path.resolve('scripts/bench-surface-pair.mjs'), '_worker', JSON.stringify({
      manifest: manifestPath, profile: 'ordinary/warm/consume', comparison: 'AA', cluster: 0,
    })];
    const result = JSON.parse(execFileSync(process.execPath, command, { encoding: 'utf8', timeout: 20_000 }));
    expect(result.semantic).toBe(true);
    expect(result.warmupBursts).toBe(SURFACE_PAIR_POLICY.warmupBursts);
    expect(result.samples.map((r: { side: number }) => r.side)).toEqual([0, 1, 1, 0]);
    expect(result.samples.every((r: { calls: number; elapsedNs: number }) => r.calls === 32 && r.elapsedNs > 0)).toBe(true);
    expect(result.clock.beforeNs).toHaveLength(64);
    expect(result.clock.afterNs).toHaveLength(64);
    // Это проверка исполнения/целостности, не wall-clock performance threshold.
    writeFileSync(equal, source + '\n// changed');
    expect(() => execFileSync(process.execPath, command, { stdio: 'pipe', timeout: 20_000 })).toThrow();
  });

  it('пересчитывает полный journal и не принимает поддельный verdict или потерянный end', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'motion-surface-replay-'));
    temporary.push(directory);
    const write = (name: string, value: unknown) => writeFileSync(path.join(directory, name), JSON.stringify(value));
    write('manifest.json', { schema: 1, policy: SURFACE_PAIR_POLICY, profiles: surfaceProfiles(), calibrateOnly: true });
    const journal: unknown[] = [{ type: 'manifest', sha256: sha256File(path.join(directory, 'manifest.json')) }];
    const rows: unknown[] = [];
    const groups = [...SURFACE_CALIBRATION_IDS.map((id: string) => [id, 'AA']), [SURFACE_CALIBRATION_IDS[0], 'double']];
    for (const [id, comparison] of groups) {
      const profile = surfaceProfiles().find((p: { id: string }) => p.id === id);
      const multipliers = comparison === 'double' ? [1, 2] : [1, 1];
      const raw = Array.from({ length: SURFACE_PAIR_POLICY.clusters }, (_, cluster) => ({
        ...record(cluster, profile.calls), profile: id, multipliers,
        samples: pairedSurfaceOrder(cluster).map((side: number) => ({
          side, calls: profile.calls * multipliers[side]!, elapsedNs: profile.calls * multipliers[side]! * 1000,
          ns: multipliers[side]! * 1000,
        })),
      }));
      journal.push(...raw.map(r => ({ type: 'cluster', comparison, ...r })));
      rows.push({ profile: id, comparison, stats: summarizeSurfacePair(raw, profile, multipliers) });
    }
    const verdict = surfaceVerdict(rows, true, true);
    journal.push({ type: 'end', verdict, completedComparisons: rows.length });
    const persistRaw = () => {
      writeFileSync(path.join(directory, 'raw.jsonl'), journal.map(row => JSON.stringify(row)).join('\n') + '\n');
      write('raw.sha256.json', { sha256: sha256File(path.join(directory, 'raw.jsonl')) });
    };
    persistRaw();
    write('summary.json', rows);
    write('verdict.json', verdict);
    expect(replaySurfaceReport(directory)).toEqual(verdict);
    write('verdict.json', { status: 'LATENCY_ADMISSION' });
    expect(() => replaySurfaceReport(directory)).toThrow('verdict расходится');
    write('verdict.json', verdict);
    journal.pop();
    persistRaw(); // Даже новый согласованный SHA не легализует неполный run.
    expect(() => replaySurfaceReport(directory)).toThrow('незавершённый raw journal');
  }, 30_000);
});
