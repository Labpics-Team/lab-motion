import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

function fail(message) {
  console.error(`release-check: ${message}`);
  process.exit(1);
}

if (pkg.name !== '@labpics/motion') {
  fail(`неожиданное имя пакета: ${String(pkg.name)}`);
}
if (pkg.private === true) fail('package.json не должен содержать private:true');
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  fail(`некорректная версия package.json: ${String(pkg.version)}`);
}
if (pkg.publishConfig?.access !== 'public') {
  fail('publishConfig.access обязан быть public');
}
if (pkg.repository?.url !== 'git+https://github.com/Labpics-Team/lab-motion.git') {
  fail('repository.url обязан точно соответствовать trusted publisher repository');
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
