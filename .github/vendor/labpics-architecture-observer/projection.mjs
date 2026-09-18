#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitReader } from './git.mjs';
import { digest, isOid, object, stableJson } from './model.mjs';
import { runtimeFiles } from './provenance.mjs';
import { parseJsonData, readRegularFile } from './input.mjs';
const REPOSITORY = 'Labpics-Team/agents-config';
const RECEIPT = 'source.json';
const members = () => [
    ...runtimeFiles.map(name => ({ path: `architecture/${name}`, local: name })),
    { path: 'architecture/projection.mjs', local: 'projection.mjs' },
    { path: 'plans/tools/code-admission/install-tools.sh', local: 'install-tools.sh' },
];
function blobId(bytes, length) {
    return createHash(length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
// Receipt verification detects local drift; authority still comes from review of
// the source commit and receipt. Hashes do not authenticate an arbitrary author.
export function verifyProjection(directory) {
    const root = path.resolve(directory);
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
        throw new Error('Projection root must be a directory, not a symlink');
    const receipt = parseJsonData(readRegularFile(path.join(root, RECEIPT), 128 * 1024));
    object(receipt, ['repository', 'commit', 'files'], 'projection receipt');
    if (receipt.repository !== REPOSITORY || !isOid(receipt.commit) || !Array.isArray(receipt.files))
        throw new TypeError('Invalid projection origin');
    const expected = new Map(members().map(m => [m.local, m.path]));
    if (receipt.files.length !== expected.size)
        throw new Error('Projection receipt has an incomplete runtime closure');
    const seen = new Set();
    for (const item of receipt.files) {
        object(item, ['path', 'local', 'blob', 'sha256'], 'projection member');
        if (!expected.has(item.local) || expected.get(item.local) !== item.path || seen.has(item.local) || !isOid(item.blob) || !/^[a-f0-9]{64}$/.test(item.sha256))
            throw new TypeError('Invalid projection member');
        seen.add(item.local);
        const bytes = readRegularFile(path.join(root, item.local));
        if (blobId(bytes, item.blob.length) !== item.blob || digest(bytes) !== item.sha256)
            throw new Error(`Projection drift: ${item.local}`);
    }
    const actual = readdirSync(root).sort();
    const required = [...expected.keys(), RECEIPT].sort();
    if (stableJson(actual) !== stableJson(required))
        throw new Error('Unexpected files in generated projection');
    return { repository: receipt.repository, commit: receipt.commit, files: receipt.files.length };
}
export function exportProjection(source, commit, directory) {
    if (!isOid(commit))
        throw new TypeError('Export requires a full immutable commit, not a branch');
    const git = new GitReader(source);
    const remote = git.text(['config', '--get', 'remote.origin.url']);
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)Labpics-Team\/agents-config(?:\.git)?$/i.test(remote))
        throw new Error('Projection source must be the canonical repository checkout');
    const oid = git.oid(commit);
    const tree = new Map(git.tree(oid).map(e => [e.path, e]));
    const selected = members().map(m => {
        const entry = tree.get(m.path);
        if (!entry || !['100644', '100755'].includes(entry.mode) || entry.type !== 'blob' || entry.size > 1024 * 1024)
            throw new Error('Source commit lacks a regular runtime member');
        return { ...entry, local: m.local };
    });
    const bytes = git.blobs(selected);
    // The complete executable closure, including the installer, must be from the
    // requested version. Flat distributions and canonical checkouts differ only
    // in their file layout; neither may substitute a member from another release.
    for (const item of selected) {
        const adjacent = new URL(item.local, import.meta.url);
        const loaded = item.local === 'install-tools.sh' && !existsSync(adjacent)
            ? new URL(`../${item.path}`, import.meta.url) : adjacent;
        if (digest(readRegularFile(loaded)) !== digest(bytes.get(item.path)))
            throw new Error('Exporter version does not match the requested source commit or installer member');
    }
    const root = path.resolve(directory);
    const parent = path.dirname(root);
    if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
        throw new Error('Projection parent must be an existing regular directory');
    mkdirSync(root, { mode: 0o700 }); // Exclusive creation; never overwrite a consumer or another worktree.
    try {
        const receipt = { repository: REPOSITORY, commit: oid, files: [] };
        for (const item of selected) {
            const content = bytes.get(item.path);
            writeFileSync(path.join(root, item.local), content, { flag: 'wx', mode: item.mode === '100755' ? 0o755 : 0o644 });
            receipt.files.push({ path: item.path, local: item.local, blob: item.oid, sha256: digest(content) });
        }
        writeFileSync(path.join(root, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
        return verifyProjection(root);
    }
    catch (error) {
        rmSync(root, { recursive: true, force: true }); // Only the directory exclusively created by this invocation.
        throw error;
    }
}
export function runProjection(argv) {
    const [command, ...rest] = argv;
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
        if (!['--source', '--ref', '--out', '--root'].includes(rest[i]) || !rest[i + 1] || options[rest[i]] !== undefined)
            throw new TypeError('Invalid projection arguments');
        options[rest[i]] = rest[i + 1];
    }
    if (command === 'export' && Object.keys(options).sort().join(',') === '--out,--ref,--source')
        return exportProjection(options['--source'], options['--ref'], options['--out']);
    if (command === 'verify' && Object.keys(options).join(',') === '--root')
        return verifyProjection(options['--root']);
    throw new TypeError('usage: projection.mjs export --source REPO --ref SHA --out NEW_DIR | verify --root DIR');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        console.log(JSON.stringify(runProjection(process.argv.slice(2))));
    }
    catch (error) {
        console.error(String(error.message).replace(/[\x00-\x1f\x7f]/g, ' '));
        process.exitCode = 2;
    }
}
