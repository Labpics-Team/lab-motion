#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROFILES = ['setup3-default', 'seek3-default'];
const BAND_LOW = 0.95;
const BAND_HIGH = 1.05;
const POSITIVE_LOW = 1.5;
const NULL_RUNS = 6;
const POSITIVE_RUNS = 6;
const AB_RUNS = 8;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function waitFifo(path, expected) {
  const text = fs.readFileSync(path, 'utf8').trim();
  if (text !== expected) fail(`unexpected fifo token ${JSON.stringify(text)} from ${path}; expected ${expected}`);
}

async function workload(args) {
  const [entry, profile, nominalRaw, factorRaw, readyPath, startFifo, doneFifo, stopFifo] = args;
  const nominal = integer(nominalRaw, 'nominal');
  const factor = integer(factorRaw, 'factor');
  if (!PROFILES.includes(profile)) fail(`unknown profile ${profile}`);

  const { keyframes } = await import(pathToFileURL(entry).href);
  const values = Object.freeze([0, 1, 2]);
  const requestFrame = () => 0;
  const seeks = Object.freeze([0.125, 0.25, 0.375, 0.625, 0.75, 0.875]);
  let sink = 0;
  let callbacks = 0;
  const onStep = (value) => {
    sink += value;
    callbacks++;
  };
  const make = () => keyframes({ values, requestFrame, onStep });

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

  fs.writeFileSync(readyPath, `${JSON.stringify({ pid: process.pid, profile, nominal, factor })}\n`);
  waitFifo(startFifo, 'go');

  const actual = nominal * factor;
  if (profile === 'setup3-default') {
    for (let i = 0; i < actual; i++) setupOnce(i);
  } else {
    for (let i = 0; i < actual; i++) seekOnce(i);
  }

  const receipt = { profile, nominal, factor, actual, sink, callbacks };
  fs.writeFileSync(doneFifo, `${JSON.stringify(receipt)}\n`);
  waitFifo(stopFifo, 'stop');
  if (seekControl) seekControl.cancel();
  if (!Number.isFinite(sink) || callbacks <= 0) fail('semantic checksum/callback control failed');
}

function readRows(path) {
  const text = fs.readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split(/\n+/).map((line, index) => {
    let row;
    try { row = JSON.parse(line); } catch { fail(`raw row ${index + 1} is not JSON`); }
    if (!PROFILES.includes(row.profile)) fail(`raw row ${index + 1}: invalid profile`);
    if (!['null-base', 'null-candidate', 'positive', 'ab'].includes(row.phase)) fail(`raw row ${index + 1}: invalid phase`);
    if (!Number.isSafeInteger(row.run) || row.run < 0) fail(`raw row ${index + 1}: invalid run`);
    if (!['a', 'b'].includes(row.side)) fail(`raw row ${index + 1}: invalid side`);
    if (!['base', 'candidate'].includes(row.impl)) fail(`raw row ${index + 1}: invalid impl`);
    if (!Number.isFinite(row.ir) || row.ir <= 0) fail(`raw row ${index + 1}: invalid Ir`);
    if (!Number.isSafeInteger(row.nominal) || row.nominal <= 0) fail(`raw row ${index + 1}: invalid nominal`);
    if (!Number.isSafeInteger(row.factor) || row.factor <= 0) fail(`raw row ${index + 1}: invalid factor`);
    return row;
  });
}

function one(rows, predicate, description) {
  const found = rows.filter(predicate);
  if (found.length !== 1) fail(`${description}: expected one row, got ${found.length}`);
  return found[0];
}

function ratios(rows, profile, phase, expectedRuns) {
  const phaseRows = rows.filter((row) => row.profile === profile && row.phase === phase);
  const runs = [...new Set(phaseRows.map((row) => row.run))].sort((a, b) => a - b);
  if (runs.length !== expectedRuns) fail(`${profile}/${phase}: expected ${expectedRuns} runs, got ${runs.length}`);
  return runs.map((run) => {
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
    const num = numerator.ir / (numerator.nominal * numerator.factor);
    const den = denominator.ir / (denominator.nominal * denominator.factor);
    const ratio = num / den;
    if (!Number.isFinite(ratio) || ratio <= 0) fail(`${profile}/${phase}/${run}: invalid ratio`);
    return { run, ratio, numeratorIrPerOperation: num, denominatorIrPerOperation: den };
  });
}

function geometricMean(values) {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

function summarizeControls(rows) {
  const output = {
    schema: 1,
    mechanism: 'valgrind-callgrind-dynamic-Ir',
    band: [BAND_LOW, BAND_HIGH],
    positiveLower: POSITIVE_LOW,
    nullRuns: NULL_RUNS,
    positiveRuns: POSITIVE_RUNS,
    abRuns: AB_RUNS,
    profiles: {},
  };
  for (const profile of PROFILES) {
    const baseNull = ratios(rows, profile, 'null-base', NULL_RUNS);
    const candidateNull = ratios(rows, profile, 'null-candidate', NULL_RUNS);
    const positive = ratios(rows, profile, 'positive', POSITIVE_RUNS);
    const nullPass = [...baseNull, ...candidateNull].every(({ ratio }) => ratio >= BAND_LOW && ratio <= BAND_HIGH);
    const positivePass = positive.every(({ ratio }) => ratio > POSITIVE_LOW);
    output.profiles[profile] = {
      admitted: nullPass && positivePass,
      baseNull,
      candidateNull,
      positive,
      nullPass,
      positivePass,
    };
  }
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
  const rows = readRows(raw);
  const result = summarizeControls(rows);
  let verdict = 'PASS-TAKEN-PATH';
  for (const profile of PROFILES) {
    const state = result.profiles[profile];
    if (!state.admitted) {
      state.verdict = 'UNPROVEN-CALIBRATION';
      if (verdict !== 'NO-GO-CALLGRIND') verdict = 'UNPROVEN-CALIBRATION';
      continue;
    }
    const ab = ratios(rows, profile, 'ab', AB_RUNS);
    const mean = geometricMean(ab.map(({ ratio }) => ratio));
    const pass = ab.every(({ ratio }) => ratio <= BAND_HIGH) && mean <= BAND_HIGH;
    state.ab = ab;
    state.abGeometricMean = mean;
    state.verdict = pass ? 'PASS' : 'NO-GO-CALLGRIND';
    if (!pass) verdict = 'NO-GO-CALLGRIND';
  }
  result.verdict = verdict;
  result.rawRows = rows.length;
  result.rawSha256 = crypto.createHash('sha256').update(fs.readFileSync(raw)).digest('hex');
  writeJson(output, result);
} else {
  fail('usage: workload|controls|final ...');
}
