import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_PROFILE, serverProfileDigest } from '../bench/profile/server-profile-registration.mjs';
import { writeServerArtifact } from '../bench/profile/server-profile-artifact.mjs';

const cli = fileURLToPath(new URL('../bench/profile/server-profile-artifact.mjs', import.meta.url));

describe('файловый адаптер серверного профиля', () => {
  it.each(['intact', 'raw', 'digest', 'journal'] as const)('CLI проверяет связанные файлы: %s', (change) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'motion profile cli-'));
    try {
      const artifact = { schema: 1, protocol: SERVER_PROFILE, registration: null, registrationDigest: null,
        verdict: 'UNPROVEN', failures: [{ stage: 'preparation', error: { message: 'нет среды' } }] };
      const rawFile = path.join(directory, 'server-profile.json');
      const journalFile = path.join(directory, 'journal.ndjson');
      const { sha256 } = writeServerArtifact(rawFile, artifact);
      let previous = '0'.repeat(64);
      const records = [{ type: 'failure', value: artifact.failures[0] },
        { type: 'finished', value: { verdict: artifact.verdict, digest: sha256 } }].map((event) => {
        const payload = { sequenceDigest: previous, ...event };
        previous = serverProfileDigest(payload);
        return { ...payload, digest: previous };
      });
      if (change === 'journal') records[0].digest = 'b'.repeat(64);
      writeFileSync(journalFile, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      if (change === 'raw') writeFileSync(rawFile, Buffer.concat([readFileSync(rawFile), Buffer.from('\n')]));
      const result = spawnSync(process.execPath, [cli, '--raw', rawFile, '--digest',
        change === 'digest' ? '0'.repeat(64) : sha256, '--journal', journalFile], { encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      if (change === 'intact') {
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ verification: 'preparation-refused', verdict: 'UNPROVEN',
          journalFinalDigest: previous });
        expect(result.stderr).toBe('');
      } else {
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(change === 'journal' ? /цепь журнала/ : /digest raw/);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
