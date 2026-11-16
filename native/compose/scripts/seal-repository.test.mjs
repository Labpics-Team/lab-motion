import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./seal-repository.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'motion-maven-'));
    t.after(() => {
        assert.ok(directory.startsWith(join(tmpdir(), 'motion-maven-')));
        rmSync(directory, { recursive: true, force: true });
    });
    const root = join(directory, 'repository');
    const modulePath = join(root, 'pics/lab/motion-compose/0.1.0/motion-compose-0.1.0.module');
    mkdirSync(dirname(modulePath), { recursive: true });
    const artifact = join(dirname(modulePath), 'motion-compose-0.1.0.jar');
    const bytes = Buffer.from('artifact');
    const write = (path, content) => { writeFileSync(path, content); writeFileSync(path + '.sha256', sha(content)); };
    write(artifact, bytes);
    const module = { component: { group: 'pics.lab', module: 'motion-compose', version: '0.1.0' },
        variants: [{ files: [{ url: 'motion-compose-0.1.0.jar', size: bytes.length, sha256: sha(bytes) }] }] };
    const update = () => write(modulePath, JSON.stringify(module));
    update();
    return { directory, root, modulePath, artifact, module, bytes, update,
        run: () => spawnSync(process.execPath, [script, root, '0.1.0', 'a'.repeat(40)], { encoding: 'utf8' }) };
}
test('complete repository seals and can be verified again', t => {
    const f = fixture(t);
    assert.equal(f.run().status, 0);
    assert.equal(f.run().status, 0);
});
test('missing artifact SHA-256 sidecar rejects the release', t => {
    const f = fixture(t);
    rmSync(f.artifact + '.sha256');
    assert.notEqual(f.run().status, 0);
});
test('valid bytes outside the distribution cannot satisfy an artifact URL', t => {
    const f = fixture(t);
    const outside = join(f.directory, 'outside.jar');
    writeFileSync(outside, f.bytes);
    f.module.variants[0].files[0].url = relative(dirname(f.modulePath), outside);
    f.update();
    assert.match(f.run().stderr, /escapes repository/);
});
test('tampering is rejected even when sidecar matches the modified file', t => {
    const f = fixture(t);
    writeFileSync(f.artifact, 'modified');
    writeFileSync(f.artifact + '.sha256', sha('modified'));
    assert.match(f.run().stderr, /does not match Gradle metadata/);
});
