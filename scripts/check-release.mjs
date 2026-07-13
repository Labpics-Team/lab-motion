import { readFileSync } from 'node:fs';
import { validateReleaseMetadata } from './release-metadata.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

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

const expectedTag = `v${pkg.version}`;
if (tag !== expectedTag) {
  fail(`тег ${tag} не совпадает с package.json (${expectedTag})`);
}

const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const releaseHeading = new RegExp(`^## \\[${escapedVersion}\\](?: —| -) \\d{4}-\\d{2}-\\d{2}$`, 'm');
if (!releaseHeading.test(changelog)) {
  fail(`CHANGELOG.md не содержит датированную секцию ## [${pkg.version}]`);
}

console.log(`release-check: ${pkg.name}@${pkg.version} соответствует ${tag}`);
