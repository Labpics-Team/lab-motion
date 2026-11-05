// Общий импорт установленного пакета для движка и отдельного дочернего процесса проверки удержаний.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_PROFILE } from './server-profile-registration.mjs';

// До сборки читаем только публичные точки входа; после распаковки проверяем реальные пути.
export function serverParticipantExportTargets(directory, participant) {
  const policy = SERVER_PROFILE.participantImports[participant];
  if (!policy) throw new Error('server profile: unknown participant import lineage');
  const metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  const exported = (key) => {
    const entry = metadata.exports?.[key]?.import?.default;
    if (typeof entry !== 'string' || !entry.startsWith('./')) throw new Error(`server profile: missing packed export ${key}`);
    return { export: key, path: entry };
  };
  return { participant, browserOwner: policy.browserOwner, browser: exported(policy.browserExport),
    engine: exported('./animate'), stock: exported(policy.stockExport) };
}

export function serverParticipantImports(directory, participant) {
  const root = realpathSync(directory);
  const targets = serverParticipantExportTargets(root, participant);
  const exported = (entry) => {
    const file = realpathSync(resolve(root, entry.path)), path = relative(root, file);
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('server profile: packed export escapes participant');
    return { export: entry.export, path: file };
  };
  return { ...targets, browser: exported(targets.browser), engine: exported(targets.engine), stock: exported(targets.stock) };
}

export async function loadServerParticipant(directory, participant) {
  const lineage = serverParticipantImports(directory, participant);
  const { animate } = await import(pathToFileURL(lineage.engine.path).href);
  const { MotionValue } = await import(pathToFileURL(lineage.stock.path).href);
  if (typeof animate !== 'function' || typeof MotionValue !== 'function') throw new Error('server profile: invalid packed legacy participant exports');
  return { animate, MotionValue, lineage };
}
