#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { chromium, firefox, webkit } from '@playwright/test';
import { pairedClusterBootstrap } from '../bench/compare/methodology.mjs';

const SEED = 20260913;
const ITERATIONS = 20_000;
const BAND_LOW = 0.95;
const BAND_HIGH = 1.05;
const POSITIVE_LOW = 1.5;
const MIN_ELAPSED_MS = 20;
const NULL_RUNS = 16;
const POSITIVE_RUNS = 8;
const AB_RUNS = 16;
const PROFILES = Object.freeze({
  'setup3-default': { warm: 5_000, nominal: 20_000 },
  'seek3-default': { warm: 100_000, nominal: 500_000 },
});
const BROWSERS = { chromium, firefox, webkit };

function fail(message) { throw new Error(message); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

async function observe(browser, source, impl, profile, factor) {
  const config = PROFILES[profile];
  if (!config) fail(`unknown profile ${profile}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const receipt = await page.evaluate(async ({ source, profile, warm, nominal, factor }) => {
      const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        const mod = await import(moduleUrl);
        if (typeof mod.keyframes !== 'function') throw new Error('keyframes export missing');
        const values = Object.freeze([0, 1, 2]);
        const seeks = Object.freeze([0.125, 0.25, 0.375, 0.625, 0.75, 0.875]);
        const requestFrame = () => 1;
        let sink = 0;
        let callbacks = 0;
        const onStep = (value) => { sink += value; callbacks++; };
        const make = () => mod.keyframes({ values, requestFrame, onStep });
        const setupOnce = (index) => {
          const control = make();
          control.pause();
          control.seek(seeks[index % seeks.length]);
          control.cancel();
          sink += control.progress;
        };
        let seekControl;
        const seekOnce = (index) => seekControl.seek(seeks[index % seeks.length]);

        if (profile === 'setup3-default') {
          for (let i = 0; i < warm; i++) setupOnce(i);
        } else {
          seekControl = make();
          seekControl.pause();
          for (let i = 0; i < warm; i++) seekOnce(i);
        }

        const actual = nominal * factor;
        const start = performance.now();
        if (profile === 'setup3-default') {
          for (let i = 0; i < actual; i++) setupOnce(i);
        } else {
          for (let i = 0; i < actual; i++) seekOnce(i);
        }
        const elapsedMs = performance.now() - start;
        if (seekControl) seekControl.cancel();
        if (!Number.isFinite(sink) || callbacks <= 0) throw new Error('semantic checksum failed');
        if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs)) throw new Error('invalid elapsed time');
        return { profile, warm, nominal, factor, actual, elapsedMs, callbacks, sink };
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
    }, { source, profile, warm: config.warm, nominal: config.nominal, factor });
    return { ...receipt, impl };
  } finally {
    await context.close();
  }
}

function one(rows, predicate, description) {
  const found = rows.filter(predicate);
  if (found.length !== 1) fail(`${description}: expected one row, got ${found.length}`);
  return found[0];
}

function evidence(rows, profile, phase) {
  const phaseRows = rows.filter((row) => row.profile === profile && row.phase === phase);
  const runs = [...new Set(phaseRows.map((row) => row.run))].sort((a, b) => a - b);
  if (runs.length < 2) fail(`${profile}/${phase}: fewer than two clusters`);
  const lab = [];
  const competitor = [];
  for (const run of runs) {
    let numerator;
    let denominator;
    if (phase === 'positive') {
      denominator = one(phaseRows, (row) => row.run === run && row.factor === 1, `${profile}/${phase}/${run}/1x`);
      numerator = one(phaseRows, (row) => row.run === run && row.factor === 2, `${profile}/${phase}/${run}/2x`);
    } else if (phase === 'ab') {
      denominator = one(phaseRows, (row) => row.run === run && row.impl === 'base', `${profile}/${phase}/${run}/base`);
      numerator = one(phaseRows, (row) => row.run === run && row.impl === 'candidate', `${profile}/${phase}/${run}/candidate`);
    } else {
      denominator = one(phaseRows, (row) => row.run === run && row.side === 'a', `${profile}/${phase}/${run}/a`);
      numerator = one(phaseRows, (row) => row.run === run && row.side === 'b', `${profile}/${phase}/${run}/b`);
    }
    if (numerator.nominal !== denominator.nominal) fail(`${profile}/${phase}/${run}: nominal mismatch`);
    lab.push({ run, samples: [numerator.elapsedMs / numerator.nominal], semantic: true });
    competitor.push({ run, samples: [denominator.elapsedMs / denominator.nominal], semantic: true });
  }
  return pairedClusterBootstrap(lab, competitor, { seed: SEED, iterations: ITERATIONS });
}

function nullPass(result) {
  return result.p50.low >= BAND_LOW && result.p50.high <= BAND_HIGH &&
    result.p95.low >= BAND_LOW && result.p95.high <= BAND_HIGH;
}
function positivePass(result) { return result.p50.low > POSITIVE_LOW && result.p95.low > POSITIVE_LOW; }
function abPass(result) { return result.p50.high <= BAND_HIGH && result.p95.high <= BAND_HIGH; }

async function main() {
  const [browserName, basePath, candidatePath, outputPrefix] = process.argv.slice(2);
  const launcher = BROWSERS[browserName];
  if (!launcher || !basePath || !candidatePath || !outputPrefix) {
    fail('usage: <chromium|firefox|webkit> <base-entry> <candidate-entry> <output-prefix>');
  }
  const baseSource = fs.readFileSync(basePath, 'utf8');
  const candidateSource = fs.readFileSync(candidatePath, 'utf8');
  const browser = await launcher.launch({ headless: true });
  const browserVersion = browser.version();
  const rows = [];
  const push = (row) => rows.push({ browser: browserName, browserVersion, ...row });

  const runOne = async (profile, phase, run, side, impl, factor) => {
    const source = impl === 'base' ? baseSource : candidateSource;
    const receipt = await observe(browser, source, impl, profile, factor);
    push({ phase, run, side, ...receipt });
  };
  const pair = async (profile, phase, run, implA, factorA, implB, factorB) => {
    const first = run % 2 === 0
      ? [['a', implA, factorA], ['b', implB, factorB]]
      : [['b', implB, factorB], ['a', implA, factorA]];
    for (const [side, impl, factor] of first) await runOne(profile, phase, run, side, impl, factor);
  };

  const collectControls = async (profile) => {
    for (let run = 0; run < NULL_RUNS; run++) await pair(profile, 'null-base', run, 'base', 1, 'base', 1);
    for (let run = 0; run < NULL_RUNS; run++) await pair(profile, 'null-candidate', run, 'candidate', 1, 'candidate', 1);
    for (let run = 0; run < POSITIVE_RUNS; run++) await pair(profile, 'positive', run, 'base', 1, 'base', 2);
  };

  const controls = {
    schema: 1, mechanism: 'real-browser-performance-now-fresh-page', browser: browserName, browserVersion,
    seed: SEED, iterations: ITERATIONS, band: [BAND_LOW, BAND_HIGH], positiveLower: POSITIVE_LOW,
    minimumElapsedMs: MIN_ELAPSED_MS, nullRuns: NULL_RUNS, positiveRuns: POSITIVE_RUNS, abRuns: AB_RUNS,
    baseSha256: sha256(baseSource), candidateSha256: sha256(candidateSource), profiles: {},
  };

  for (const profile of Object.keys(PROFILES)) {
    await collectControls(profile);
    const baseNull = evidence(rows, profile, 'null-base');
    const candidateNull = evidence(rows, profile, 'null-candidate');
    const positive = evidence(rows, profile, 'positive');
    const controlRows = rows.filter((row) => row.profile === profile && row.phase !== 'ab');
    const durationPass = controlRows.filter((row) => row.factor === 1).every((row) => row.elapsedMs >= MIN_ELAPSED_MS);
    const admitted = durationPass && nullPass(baseNull) && nullPass(candidateNull) && positivePass(positive);
    controls.profiles[profile] = { admitted, durationPass, baseNull, candidateNull, positive };
  }

  fs.writeFileSync(`${outputPrefix}-controls.json`, `${JSON.stringify(controls, null, 2)}\n`);

  for (const [profile, state] of Object.entries(controls.profiles)) {
    if (!state.admitted) continue;
    for (let run = 0; run < AB_RUNS; run++) await pair(profile, 'ab', run, 'base', 1, 'candidate', 1);
  }
  await browser.close();

  fs.writeFileSync(`${outputPrefix}-raw.jsonl`, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const result = structuredClone(controls);
  let verdict = 'PASS-BROWSER';
  for (const profile of Object.keys(PROFILES)) {
    const state = result.profiles[profile];
    if (!state.admitted) {
      state.verdict = 'UNPROVEN-CALIBRATION';
      if (verdict !== 'NO-GO-BROWSER') verdict = 'UNPROVEN-CALIBRATION';
      continue;
    }
    const abRows = rows.filter((row) => row.profile === profile && row.phase === 'ab');
    const abDurationPass = abRows.every((row) => row.elapsedMs >= MIN_ELAPSED_MS);
    if (!abDurationPass) {
      state.verdict = 'UNPROVEN-MIN-DURATION';
      verdict = verdict === 'NO-GO-BROWSER' ? verdict : 'UNPROVEN-CALIBRATION';
      continue;
    }
    const ab = evidence(rows, profile, 'ab');
    const pass = abPass(ab);
    state.ab = ab;
    state.abDurationPass = true;
    state.verdict = pass ? 'PASS' : 'NO-GO-BROWSER';
    if (!pass) verdict = 'NO-GO-BROWSER';
  }
  result.verdict = verdict;
  result.rawRows = rows.length;
  result.rawSha256 = crypto.createHash('sha256').update(fs.readFileSync(`${outputPrefix}-raw.jsonl`)).digest('hex');
  fs.writeFileSync(`${outputPrefix}-result.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ browser: browserName, browserVersion, verdict, rawRows: rows.length }));
}

await main();
