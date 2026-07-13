import { readFileSync } from 'node:fs';
import { validateReleaseChangelog, validateReleaseMetadata } from './release-metadata.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const releaseDate = process.argv[3] ?? process.env.RELEASE_DATE;

function fail(message) {
  console.error(`release-check: ${message}`);
  process.exit(1);
}

try {
  validateReleaseMetadata(pkg);
} catch (error) {
  fail(error?.message ?? String(error));
}
if (!tag) fail('передайте Git-тег аргументом или через GITHUB_REF_NAME');
if (!releaseDate) fail('передайте UTC-дату release intent аргументом или через RELEASE_DATE');

const expectedTag = `v${pkg.version}`;
if (tag !== expectedTag) {
  fail(`тег ${tag} не совпадает с package.json (${expectedTag})`);
}

try {
  validateReleaseChangelog(changelog, pkg.version, releaseDate);
} catch (error) {
  fail(error?.message ?? String(error));
}

console.log(`release-check: ${pkg.name}@${pkg.version} соответствует ${tag} и ${releaseDate}`);
