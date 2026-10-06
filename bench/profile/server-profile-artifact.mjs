import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Bytes } from '../compare/provenance.mjs';
import { parseServerJsonBytes, parseServerJournalBytes, serverArtifactChunks,
  validateServerArtifact, validateServerJournal } from './server-profile-contract.mjs';

// Файловый адаптер использует тот же carrier и проверки, что и контракт профиля.
// Эксклюзивное создание сохраняет уже записанный результат при повторном запуске.
export function writeServerArtifact(file, artifact) {
  const descriptor = openSync(file, 'wx'), hash = createHash('sha256');
  let bytes = 0;
  try {
    for (const chunk of serverArtifactChunks(artifact)) {
      const buffer = Buffer.from(chunk); hash.update(buffer); bytes += buffer.length;
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
  } finally { closeSync(descriptor); }
  return { sha256: hash.digest('hex'), bytes };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--raw' || args[2] !== '--digest' || args[4] !== '--journal') {
      throw new Error('server profile: нужны --raw <json> --digest <внешний sha256> --journal <ndjson>');
    }
    const raw = readFileSync(args[1]);
    if (!/^[a-f0-9]{64}$/.test(args[3]) || sha256Bytes(raw) !== args[3]) {
      throw new Error('server profile: не совпал внешний digest raw');
    }
    const artifact = parseServerJsonBytes(raw);
    const records = parseServerJournalBytes(readFileSync(args[5]));
    const chronology = validateServerJournal(artifact, records, args[3]);
    process.stdout.write(`${JSON.stringify({ ...validateServerArtifact(artifact), ...chronology })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
