import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { classifyPath, graphEligible, isOid, repoPath } from './model.mjs';
const MAX_BUFFER = 96 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const cleanToken = v => v?.replace(/^\n+/, '');
export class GitReader {
    constructor(directory) {
        this.directory = path.resolve(directory);
        this.environment = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: process.platform === 'win32' ? process.env.USERPROFILE : '/nonexistent',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    }
    bytes(args, input) {
        try {
            return execFileSync('git', ['--no-pager', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'log.showSignature=false', '-c', 'color.ui=false', '-C', this.directory, ...args], { env: this.environment, input, maxBuffer: MAX_BUFFER, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
        }
        catch (e) {
            throw new Error(`Git ${args[0]} failed (status=${e.status ?? 'unknown'}, code=${e.code ?? 'none'})`);
        }
    }
    text(args) { return decoder.decode(this.bytes(args)).trim(); }
    oid(ref) {
        if (typeof ref !== 'string' || !ref || ref.length > 4096 || ref.includes('\0'))
            throw new TypeError('Invalid Git ref');
        const sha = this.text(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
        if (!isOid(sha))
            throw new Error('Expected immutable commit');
        return sha;
    }
    mergeBase(base, head) {
        if (!isOid(base) || !isOid(head))
            throw new TypeError('Expected commit identities');
        const refs = this.text(['merge-base', '--all', base, head]).split('\n');
        if (refs.length !== 1 || !isOid(refs[0]))
            throw new Error('Comparison needs one unambiguous merge base');
        return refs[0];
    }
    changedPaths(base, head) {
        if (!isOid(base) || !isOid(head))
            throw new TypeError('Expected commit identities');
        return nulFields(this.bytes(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', base, head, '--'])).map(repoPath);
    }
    tree(commit) {
        if (!isOid(commit))
            throw new TypeError('Expected immutable commit');
        return nulFields(this.bytes(['ls-tree', '-rz', '-l', '--full-tree', commit])).map(f => {
            const tab = f.indexOf('\t');
            if (tab < 0)
                throw new Error('Malformed tree entry');
            const [mode, type, oid, size] = f.slice(0, tab).trim().split(/\s+/);
            const p = repoPath(f.slice(tab + 1));
            if (!/^[0-7]{6}$/.test(mode) || !isOid(oid))
                throw new Error('Invalid tree object');
            const s = size === '-' ? null : Number(size);
            if (s !== null && (!Number.isSafeInteger(s) || s < 0))
                throw new Error('Invalid tree size');
            return { mode, type, oid, size: s, path: p };
        });
    }
    blobs(entries) {
        if (!entries.length)
            return new Map();
        let budget = 0;
        for (const e of entries) {
            if (e.type !== 'blob' || !isOid(e.oid) || !Number.isSafeInteger(e.size) || e.size < 0)
                throw new TypeError('Invalid blob request');
            budget += e.size + 128;
        }
        if (budget > MAX_BUFFER - 1024)
            throw new Error('Snapshot exceeds 96 MiB resource budget');
        const bytes = this.bytes(['cat-file', '--batch'], entries.map(e => e.oid).join('\n') + '\n');
        let offset = 0;
        const result = new Map();
        for (const e of entries) {
            const end = bytes.indexOf(10, offset);
            if (end < 0)
                throw new Error('Truncated blob header');
            const [oid, type, size] = bytes.subarray(offset, end).toString('ascii').split(' ');
            if (oid !== e.oid || type !== 'blob' || Number(size) !== e.size)
                throw new Error('Blob identity mismatch');
            offset = end + 1;
            const content = bytes.subarray(offset, offset + e.size);
            offset += e.size;
            if (content.length !== e.size || bytes[offset++] !== 10)
                throw new Error('Truncated blob');
            result.set(e.path, content);
        }
        if (offset !== bytes.length)
            throw new Error('Unconsumed blob output');
        return result;
    }
    snapshot(commit, config) {
        const entries = this.tree(commit), omitted = [];
        const selected = entries.filter(e => {
            let reason = null;
            if (!['100644', '100755'].includes(e.mode) || e.type !== 'blob')
                reason = 'symlink-or-submodule-not-followed';
            else if (classifyPath(e.path, config) === 'excluded-directory')
                reason = 'excluded-directory';
            else if (e.size > 1024 * 1024)
                reason = 'file-over-1-MiB';
            else if (!graphEligible(e.path, config) && classifyPath(e.path, config) !== 'configuration')
                reason = classifyPath(e.path, config);
            if (reason)
                omitted.push({ path: e.path, reason });
            return reason === null;
        });
        if (selected.length > 30000)
            throw new Error('Snapshot exceeds 30000-file budget');
        const files = new Map();
        for (const [p, b] of this.blobs(selected)) {
            try {
                if (b.includes(0))
                    throw new Error('binary');
                files.set(p, decoder.decode(b));
            }
            catch {
                omitted.push({ path: p, reason: 'binary-or-non-UTF8' });
            }
        }
        return { commit, tree: this.text(['rev-parse', `${commit}^{tree}`]), entries, files, omitted };
    }
    readFile(commit, p, maxBytes = 256 * 1024) {
        repoPath(p);
        const e = this.tree(commit).find(e => e.path === p);
        if (!e)
            return null;
        if (e.type !== 'blob' || !['100644', '100755'].includes(e.mode) || e.size > maxBytes)
            throw new Error('Refused non-regular or oversized configuration');
        return decoder.decode(this.blobs([e]).get(p));
    }
    history(commit, settings) {
        if (!isOid(commit))
            throw new TypeError('Expected immutable commit');
        const until = Number(this.text(['show', '-s', '--format=%ct', commit]));
        if (!Number.isSafeInteger(until))
            throw new Error('Invalid timestamp');
        const since = until - settings.windowDays * 86400;
        // Filter timestamps after bounded traversal: --since can stop at a skewed date.
        const raw = this.bytes(['log', '--first-parent', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--format=%H%x00%P%x00%ct%x00', '--name-status', '-z', '--find-renames=100%', `--max-count=${settings.maxCommits + 1}`, commit, '--']);
        const observed = parseNameStatus(raw), truncated = observed.length > settings.maxCommits, shallow = this.text(['rev-parse', '--is-shallow-repository']) === 'true';
        return { events: observed.slice(0, settings.maxCommits), complete: !truncated && !shallow, truncated, shallow, since, until, subjectCommit: commit, gitVersion: this.text(['--version']), unit: 'first-parent commit; merge contributes its integration diff, not its child commits', renamePolicy: 'exact-content renames only; edited renames may start a new lineage' };
    }
}
export function nulFields(bytes) {
    if (!bytes.length)
        return [];
    if (bytes.at(-1) !== 0)
        throw new Error('Truncated NUL-delimited Git output');
    return decoder.decode(bytes.subarray(0, -1)).split('\0');
}
function looksHeader(f, i) { return isOid(cleanToken(f[i])) && typeof f[i + 1] === 'string' && f[i + 1].split(' ').filter(Boolean).every(isOid) && /^\d+$/.test(f[i + 2] ?? ''); }
export function parseNameStatus(bytes) {
    const f = nulFields(bytes), events = [], seen = new Set();
    let i = 0;
    while (i < f.length) {
        if (!looksHeader(f, i))
            throw new Error('Malformed Git history header');
        const sha = cleanToken(f[i++]), parents = f[i++].split(' ').filter(Boolean), time = Number(f[i++]);
        if (!Number.isSafeInteger(time) || seen.has(sha))
            throw new Error('Invalid or duplicate commit');
        seen.add(sha);
        const changes = [], paths = new Set();
        while (i < f.length && f[i] === '')
            i++;
        while (i < f.length && !looksHeader(f, i)) {
            if (f[i] === '') {
                i++;
                continue;
            }
            const m = cleanToken(f[i++])?.match(/^([ACDMRTUXB])(\d{0,3})$/);
            if (!m)
                throw new Error('Malformed name-status record');
            const status = m[1];
            let oldPath, p;
            if (status === 'R' || status === 'C') {
                oldPath = repoPath(f[i++]);
                p = repoPath(f[i++]);
            }
            else {
                p = repoPath(f[i++]);
                oldPath = p;
            }
            if (paths.has(p))
                throw new Error('Duplicate changed path');
            paths.add(p);
            changes.push({ status, oldPath, path: p, ...(['R', 'C'].includes(status) ? { similarity: Number(m[2]) } : {}) });
        }
        events.push({ sha, parents, time, changes });
    }
    return events;
}
