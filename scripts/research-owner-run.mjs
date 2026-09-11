import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Архивный commit более не является предком checkout. Доставляем тот же blob
// явно, не меняя эксперимент и не полагаясь на fetch недостижимой Git-истории.
const path = 'scripts/research-event-map-archive.mjs';
const archive = readFileSync(path);
const oid = createHash('sha1').update(`blob ${archive.length}\0`).update(archive).digest('hex');
assert.equal(oid, '0e597a9b924f323627cc195fd49d982403b420b5');
const source = readFileSync('scripts/research-map-owner.mjs', 'utf8');
const from = "git('show', 'a8c3958be816bfa164516b9cf6f60401651ea38a:scripts/research-event-map-final.mjs')";
assert.equal(source.split(from).length, 2);
writeFileSync('scripts/research-owner-resolved.mjs', source.replace(from, `readFileSync('${path}', 'utf8')`));
await import('./research-owner-resolved.mjs');
