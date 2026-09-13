#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pairedClusterBootstrap } from '../bench/compare/methodology.mjs';

const SEED = 20260913;
const ITERATIONS = 20_000;
const BAND_LOW = 0.95;
const BAND_HIGH = 1.05;
const POSITIVE_LOW = 1.5;
const METRICS = ['instructions', 'cycles'];
const PROFILES = ['setup3-default', 'seek3-default'];

function fail(message) {
  console.error(message);
  process.exit(2);
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function waitFifo(path) {
  const text = fs.readFileSync(path, 'utf8').trim();
  if (text !== 'go' && text !== 'stop') fail(`unexpected fifo token ${JSON.stringify(text)} from ${path}`);
  return text;
}

async function workload(args) {
  const [entry, profile, nominalRaw, factorRaw, readyPath, startFifo, doneFifo, stopFifo] = args;
  const nominal = integer(nominalRaw, 'nominal');
  const factor = integer(factorRaw, 'factor');
  if (!PROFILES.includes(profile)) fail(`unknown profile ${profile}`);

  const { keyframes } = await import(pathToFileURL(entry).href);
  const values = Object.freeze([0, 1, 2]);
  const requestFrame = () => 0;
  let sink = 0;
  let callbacks = 0;
  const onStep = (value) => {
    sink += value;
    callbacks++;
  };
  const make = () => keyframes({ values, requestFrame, onStep });
  const seeks = Object.freeze([0.125, 0.25, 0.375, 0.625, 0.75, 0.875]);

  const setupOnce = (index) => {
    const control = make();
    control.pause();
    control.seek(seeks[index % seeks.length]);
    control.cancel();
    sink += control.progress;
  };

  let seekControl;
  const seekOnce = (index) => {
    seekControl.seek(seeks[index % seeks.length]);
  };

  if (profile === 'setup3-default') {
    for (let i = 0; i < 5_000; i++) setupOnce(i);
  } else {
    seekControl = make();
    seekControl.pause();
    for (let i = 0; i < 100_000; i++) seekOnce(i);
  }

  // Ensure warm allocations do not deterministically leak into the counted window.
  if (typeof globalThis.gc === 'function') globalThis.gc();
  fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, profile, nominal, factor }));
  if (waitFifo(startFifo) !== 'go') fail('start token missing');

  const actual = nominal * factor;
  if (profile === 'setup3-default') {
    for (let i = 0; i < actual; i++) setupOnce(i);
  } else {
    for (let i = 0; i < actual; i++) seekOnce(i);
  }

  const receipt = { profile, nominal, factor, actual, sink, callbacks };
  fs.writeFileSync(doneFifo, `${JSON.stringify(receipt)}\n`);
  if (waitFifo(stopFifo) !== 'stop') fail('stop token missing');
  if (seekControl) seekControl.cancel();
  if (!Number.isFinite(sink) || callbacks <= 0) fail('semantic checksum/callback control failed');
  console.log(JSON.stringify(receipt));
}

function readRows(path) {
  const text = fs.readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split(/\n+/).map((line, index) => {
    let row;
    try { row = JSON.parse(line); } catch { fail(`raw row ${index + 1} is not JSON`); }
    for (const metric of METRICS) {
      if (!Number.isFinite(row[metric]) || row[metric] <= 0) fail(`raw row ${index + 1} has invalid ${metric}`);
    }
    if (!PROFILES.includes(row.profile)) fail(`raw row ${index + 1} has invalid profile`);
    if (!Number.isSafeInteger(row.run) || row.run < 0) fail(`raw row ${index + 1} has invalid run`);
    if (!Number.isSafeInteger(row.nominal) || row.nominal <= 0) fail(`raw row ${index + 1} has invalid nominal`);
    return row;
  });
}

function one(rows, predicate, description) {
  const found = rows.filter(predicate);
  if (found.length !== 1) fail(`${description}: expected one row, got ${found.length}`);
  return found[0];
}

function evidence(rows, profile, phase, metric) {
  const phaseRows = rows.filter((row) => row.profile === profile && row.phase === phase);
  const runs = [...new Set(phaseRows.map((row) => row.run))].sort((a, b) => a - b);
  if (runs.length < 2) fail(`${profile}/${phase}: fewer than two clusters`);
  const lab = [];
  const competitor = [];
  for (const run of runs) {
    let labRow;
    let competitorRow;
    if (phase === 'positive') {
      competitorRow = one(phaseRows, (row) => row.run === run && row.factor === 1, `${profile}/${phase}/${run}/1x`);
      labRow = one(phaseRows, (row) => row.run === run && row.factor === 2, `${profile}/${phase}/${run}/2x`);
    } else if (phase === 'ab') {
      competitorRow = one(phaseRows, (row) => row.run === run && row.impl === 'base', `${profile}/${phase}/${run}/base`);
      labRow = one(phaseRows, (row) => row.run === run && row.impl === 'candidate', `${profile}/${phase}/${run}/candidate`);
    } else {
      competitorRow = one(phaseRows, (row) => row.run === run && row.side === 'a', `${profile}/${phase}/${run}/a`);
      labRow = one(phaseRows, (row) => row.run === run && row.side === 'b', `${profile}/${phase}/${run}/b`);
    }
    if (labRow.nominal !== competitorRow.nominal) fail(`${profile}/${phase}/${run}: nominal mismatch`);
    lab.push({ run, samples: [labRow[metric] / labRow.nominal], semantic: true });
    competitor.push({ run, samples: [competitorRow[metric] / competitorRow.nominal], semantic: true });
  }
  return pairedClusterBootstrap(lab, competitor, { seed: SEED, iterations: ITERATIONS });
}

function nullPass(result) {
  return result.p50.low >= BAND_LOW && result.p50.high <= BAND_HIGH &&
    result.p95.low >= BAND_LOW && result.p95.high <= BAND_HIGH;
}
function positivePass(result) {
  return result.p50.low > POSITIVE_LOW && result.p95.low > POSITIVE_LOW;
}
function abPass(result) {
  return result.p50.high <= BAND_HIGH && result.p95.high <= BAND_HIGH;
}

function summarizeControls(rows) {
  const output = {
    schema: 1,
    seed: SEED,
    iterations: ITERATIONS,
    band: [BAND_LOW, BAND_HIGH],
    positiveLower: POSITIVE_LOW,
    profiles: {},
  };
  for (const profile of PROFILES) {
    const controls = {};
    let admitted = true;
    for (const metric of METRICS) {
      const baseNull = evidence(rows, profile, 'null-base', metric);
      const candidateNull = evidence(rows, profile, 'null-candidate', metric);
      const positive = evidence(rows, profile, 'positive', metric);
      const metricPass = nullPass(baseNull) && nullPass(candidateNull) && positivePass(positive);
      controls[metric] = { baseNull, candidateNull, positive, pass: metricPass };
      admitted &&= metricPass;
    }
    output.profiles[profile] = { admitted, controls };
  }
  return output;
}

function finalize(rows) {
  const output = summarizeControls(rows);
  let overall = 'GO-PMU';
  for (const profile of PROFILES) {
    const state = output.profiles[profile];
    if (!state.admitted) {
      state.verdict = 'UNPROVEN-CALIBRATION';
      overall = overall === 'NO-GO-PMU' ? overall : 'UNPROVEN-CALIBRATION';
      continue;
    }
    state.ab = {};
    let pass = true;
    for (const metric of METRICS) {
      const result = evidence(rows, profile, 'ab', metric);
      const metricPass = abPass(result);
      state.ab[metric] = { ...result, pass: metricPass };
      pass &&= metricPass;
    }
    state.verdict = pass ? 'PASS' : 'NO-GO-PMU';
    if (!pass) overall = 'NO-GO-PMU';
  }
  output.verdict = overall;
  output.rawRows = rows.length;
  return output;
}

function writeJson(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'workload') {
  await workload(args);
} else if (command === 'controls') {
  const [raw, output] = args;
  writeJson(output, summarizeControls(readRows(raw)));
} else if (command === 'final') {
  const [raw, output] = args;
  writeJson(output, finalize(readRows(raw)));
} else {
  fail('usage: workload|controls|final ...');
}
