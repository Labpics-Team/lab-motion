// Один packed import owner для engine и отдельного retention child.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_PROFILE } from './server-profile-registration.mjs';

export function serverParticipantImports(directory, participant) {
  const policy = SERVER_PROFILE.participantImports[participant];
  if (!policy) throw new Error('server profile: unknown participant import lineage');
  const root = realpathSync(directory);
  const metadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const exported = (key) => {
    const entry = metadata.exports?.[key]?.import?.default;
    if (typeof entry !== 'string' || !entry.startsWith('./')) throw new Error(`server profile: missing packed export ${key}`);
    const file = realpathSync(resolve(root, entry)), path = relative(root, file);
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('server profile: packed export escapes participant');
    return { export: key, path: file };
  };
  return { participant, browserOwner: policy.browserOwner, browser: exported(policy.browserExport),
    engine: exported('./animate'), stock: exported(policy.stockExport) };
}

export async function loadServerParticipant(directory, participant) {
  const lineage = serverParticipantImports(directory, participant);
  const { animate } = await import(pathToFileURL(lineage.engine.path).href);
  const { MotionValue } = await import(pathToFileURL(lineage.stock.path).href);
  if (typeof animate !== 'function' || typeof MotionValue !== 'function') throw new Error('server profile: invalid packed legacy participant exports');
  return { animate, MotionValue, lineage };
}
