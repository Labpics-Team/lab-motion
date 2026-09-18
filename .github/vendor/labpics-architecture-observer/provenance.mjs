import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// Explicit shipped runtime closure; candidate files cannot select this set.
export const runtimeFiles = ['analyze.mjs', 'ci-feedback.mjs', 'cli.mjs', 'git.mjs', 'history.mjs', 'input.mjs', 'model.mjs', 'native-syntax.mjs', 'provenance.mjs', 'protocols.mjs', 'report.mjs', 'semantic-admission.mjs', 'source-graph.mjs', 'syntax-values.mjs'];
export function implementationDigest() {
    const hash = createHash('sha256');
    for (const name of runtimeFiles) {
        const bytes = readFileSync(new URL(name, import.meta.url));
        hash.update(`${name}\0${bytes.length}\0`);
        hash.update(bytes);
    }
    return hash.digest('hex');
}
