import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';

const [directory, version, sourceSha] = process.argv.slice(2);
if (!directory || !/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('Usage: seal-repository.mjs directory x.y.z source-sha');
}
const root = resolve(directory);
const entry = join(root, 'pics/lab/motion-compose', version, `motion-compose-${version}.module`);
const visited = new Set();
function verifyModule(file) {
    if (visited.has(file)) return;
    if (!file.startsWith(root + sep)) throw new Error('Module escapes repository');
    visited.add(file);
    const module = JSON.parse(readFileSync(file, 'utf8'));
    if (module.component.group !== 'pics.lab' || module.component.version !== version) throw new Error(`Unexpected module identity: ${file}`);
    for (const variant of module.variants) {
        if (variant['available-at']) verifyModule(resolve(dirname(file), variant['available-at'].url));
        for (const asset of variant.files ?? []) {
            const target = resolve(dirname(file), asset.url);
            const bytes = readFileSync(target);
            if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
                throw new Error(`Artifact does not match Gradle metadata: ${target}`);
            }
        }
    }
}
verifyModule(entry);
function verifyChecksums(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, item.name);
        if (item.isDirectory()) verifyChecksums(file);
        else if (file.endsWith('.sha256')) {
            const actual = createHash('sha256').update(readFileSync(file.slice(0, -7))).digest('hex');
            if (readFileSync(file, 'utf8').trim() !== actual) throw new Error(`Invalid checksum: ${file}`);
        }
    }
}
verifyChecksums(root);
writeFileSync(join(root, 'source.json'), JSON.stringify({ repository: 'Labpics-Team/lab-motion', sourceSha, version, modules: visited.size }, null, 2) + '\n');
console.log(`Verified ${visited.size} Maven modules, all Gradle metadata assets and SHA-256 sidecars`);
