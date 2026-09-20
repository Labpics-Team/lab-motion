import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GitReader } from '../../../architecture/git.mjs';
import { digest } from '../../../architecture/model.mjs';

// Git, а не mutable checkout, определяет каждый байт сканируемого предмета.
export function materializeSnapshot(repository, ref, destination) {
  const git = new GitReader(repository), commit = git.oid(ref);
  const entries = git.tree(commit);
  if (entries.length > 30000) throw new Error('Security snapshot exceeds the 30000-file budget');
  let bytes = 0;
  for (const entry of entries) {
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error('Security snapshot refuses symlink/submodule indirection');
    bytes += entry.size;
    if (entry.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024) throw new Error('Security snapshot exceeds the byte budget');
  }
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  let batch = [], size = 0;
  const flush = () => {
    for (const [path, content] of git.blobs(batch)) {
      const target = join(destination, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { flag: 'wx', mode: 0o400 });
    }
    batch = []; size = 0;
  };
  for (const entry of entries) {
    if (size + entry.size > 64 * 1024 * 1024) flush();
    batch.push(entry); size += entry.size;
  }
  flush();
  return { commit, tree: git.text(['rev-parse', `${commit}^{tree}`]), inventoryDigest: digest(entries), files: entries.length, bytes };
}
