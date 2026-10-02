import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseServerJsonBytes, parseServerJournalBytes, validateServerJournal, validateServerArtifact, serverCellPairs, validateServerEngineSample, validateServerBrowserSample } from '/tmp/motion-qualified-measurement-fe092-20261002/source/bench/profile/server-profile-contract.mjs';
import { SERVER_PROFILE, planServerSampleSize, serverProfileDigest } from '/tmp/motion-qualified-measurement-fe092-20261002/source/bench/profile/server-profile-registration.mjs';
const root = '/tmp/motion-epoch8-actual-prefix-acceptance-20261002/PRIMARY';
const bytes = readFileSync(`${root}/server-profile.json`);
const rawDigest = createHash('sha256').update(bytes).digest('hex');
if (rawDigest !== 'd098aad5475f93813cf47c096d9a1c0335e73949730903dd2cfd4190fa038975') throw new Error('raw input digest mismatch');
const artifact = parseServerJsonBytes(bytes);
const records = parseServerJournalBytes(readFileSync(`${root}/journal.ndjson`));
const journal = validateServerJournal(artifact, records, rawDigest);
const disposition = validateServerArtifact(artifact);
const counts = {};
for (const name of ['warmup', 'pilot', 'aa']) {
  let engine = 0, browser = 0;
  for (const row of artifact[name].rows) for (const sample of Object.values(row.samples)) {
    const scene = (row.kind === 'engine' ? SERVER_PROFILE.engineScenes : SERVER_PROFILE.browserScenes).find(x => x.id === row.scene);
    if (row.kind === 'engine') { validateServerEngineSample(sample, scene); engine++; }
    else { validateServerBrowserSample(sample, scene); browser++; }
  }
  counts[name] = { engine, browser };
}
const warmupCells = serverCellPairs(artifact.warmup, SERVER_PROFILE.warmupRuns, 'warmup', artifact.registration.engineClock);
const pilotCells = serverCellPairs(artifact.pilot, SERVER_PROFILE.pilotRuns, 'pilot', artifact.registration.engineClock);
const recomputedPlan = planServerSampleSize(pilotCells);
if (!isDeepStrictEqual(recomputedPlan, artifact.samplePlan)) throw new Error('canonical pilot plan mismatch');
if (serverProfileDigest(recomputedPlan) !== artifact.frozenPlanDigest) throw new Error('canonical frozen plan digest mismatch');
process.stdout.write(JSON.stringify({ rawDigest, journal, disposition, completeRawSamplesValidated: counts, fullWarmupCells: warmupCells.length, fullPilotCells: pilotCells.length, recomputedPlan, frozenPlanDigest: artifact.frozenPlanDigest, protocolDigest: serverProfileDigest(SERVER_PROFILE), registrationDigest: serverProfileDigest(artifact.registration) }, null, 2) + '\n');
