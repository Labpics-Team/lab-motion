#!/usr/bin/env node

/**
 * Релиз обязан быть адресуем одной неизменяемой версией во всех источниках.
 * Проверка выполняется до publish, чтобы несовпадение тега, package.json и
 * changelog не создало артефакт, который невозможно однозначно воспроизвести.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

function fail(message) {
  console.error(`check-release: FAIL — ${message}`);
  process.exit(1);
}

if (!tag) fail('не передан тег vX.Y.Z');
if (pkg.private === true) fail('package.json#private не должен быть true');
if (pkg.publishConfig?.access !== 'public') {
  fail('package.json#publishConfig.access должен быть public');
}

const expectedTag = `v${pkg.version}`;
if (tag !== expectedTag) {
  fail(`тег ${tag} не совпадает с package.json#version ${pkg.version}; ожидается ${expectedTag}`);
}

const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const releaseHeading = new RegExp(`^## \\[${escapedVersion}\\](?: - \\d{4}-\\d{2}-\\d{2})?$`, 'm');
if (!releaseHeading.test(changelog)) {
  fail(`CHANGELOG.md не содержит заголовок ## [${pkg.version}] - YYYY-MM-DD`);
}

console.info(`check-release: PASS — ${tag}, package.json и CHANGELOG.md согласованы`);
