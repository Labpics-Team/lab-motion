import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest } from './model.mjs';
import { stringValue, rustUsePaths, withoutComments } from './syntax-values.mjs';
const LANGUAGES = {
    TypeScript: { extensions: ['.ts', '.mts', '.cts'], root: 'program' },
    Tsx: { extensions: ['.tsx', '.jsx'], root: 'program' },
    JavaScript: { extensions: ['.js', '.mjs', '.cjs'], root: 'program' },
    Go: { extensions: ['.go'], root: 'source_file' },
    Rust: { extensions: ['.rs'], root: 'source_file' },
    Python: { extensions: ['.py'], root: 'module' },
};
export function languageFor(file) { return Object.entries(LANGUAGES).find(([, v]) => v.extensions.includes(path.posix.extname(file)))?.[0] ?? null; }
function queries(language) {
    const common = [{ id: 'root', kind: LANGUAGES[language].root }, { id: 'error', kind: 'ERROR' }];
    if (['TypeScript', 'Tsx', 'JavaScript'].includes(language))
        return [...common,
            { id: 'import', kind: 'import_statement > string' }, { id: 're-export', kind: 'export_statement > string' },
            { id: 'dynamic-import', pattern: 'import($P)' }, { id: 'require', pattern: 'require($P)' }];
    if (language === 'Go')
        return [...common, { id: 'import', kind: 'import_spec > interpreted_string_literal' }, { id: 'import', kind: 'import_spec > raw_string_literal' }];
    if (language === 'Rust')
        return [...common, { id: 'rust-use', kind: 'use_declaration' }, { id: 'rust-qualified', kind: 'scoped_identifier' }, { id: 'rust-qualified', kind: 'scoped_type_identifier' }];
    return [...common, { id: 'python-from', kind: 'import_from_statement' }, { id: 'python-import', kind: 'import_statement' }];
}
function decoded(match, query, language) {
    if (['root', 'error'].includes(query))
        return [];
    if (query === 'rust-use') {
        const body = withoutComments(match.text).replace(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+/, '').replace(/;\s*$/, '');
        return rustUsePaths(body).map(specifier => ({ kind: 'import', specifier }));
    }
    if (query === 'rust-qualified')
        return [{ kind: 'import', specifier: withoutComments(match.text).replace(/\s/g, '') }];
    if (query === 'python-from') {
        const m = /^from\s+([.\w]+)\s+import\s+([\s\S]+)/.exec(match.text.trim());
        if (!m)
            return [];
        // `from . import a` targets a, not the package initializer alone.
        if (/^\.+$/.test(m[1]))
            return m[2].replace(/[()]/g, '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(s => /^\w+$/.test(s)).map(s => ({ kind: 'import', specifier: m[1] + s }));
        return [{ kind: 'import', specifier: m[1] }];
    }
    if (query === 'python-import')
        return match.text.replace(/^\s*import\s+/, '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(s => /^[\w.]+$/.test(s)).map(specifier => ({ kind: 'import', specifier }));
    const value = ['require', 'dynamic-import'].includes(query) ? match.metaVariables?.single?.P?.text : match.text;
    const specifier = language === 'Go' && value?.startsWith('`') ? value.slice(1, -1) : stringValue(value);
    return specifier === null || specifier === undefined ? [] : [{ kind: query, specifier }];
}
// The binary is selected by the caller, never by candidate config. `run`, unlike
// lint `scan`, does not honor inline lint suppressions. Only UTF-8 Git blobs are
// materialized under synthetic filenames in a fresh directory without configs.
export function createSyntaxCollector(binary) {
    const executable = path.resolve(binary), environment = { PATH: process.env.PATH, HOME: '/nonexistent', NO_COLOR: '1', LC_ALL: 'C' };
    const invoke = (args, cwd) => {
        const r = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 192 * 1024 * 1024 });
        if (r.error || ![0, 1].includes(r.status))
            throw new Error(`AST collector failed (${r.error?.code ?? r.status}); candidate source omitted from diagnostics`);
        return r.stdout;
    };
    const version = invoke(['--version'], tmpdir()).trim();
    if (!/^ast-grep \d+\.\d+\.\d+/.test(version))
        throw new Error('Unexpected AST collector executable');
    const producer = { name: 'ast-grep', version, digest: digest(readFileSync(executable)) };
    return {
        producer,
        collect(files) {
            const directory = mkdtempSync(path.join(tmpdir(), 'labpics-ast-')), result = new Map();
            try {
                let id = 0;
                for (const [language, { extensions }] of Object.entries(LANGUAGES)) {
                    const group = new Map([...files].filter(([p]) => languageFor(p) === language));
                    if (!group.size)
                        continue;
                    const subdir = path.join(directory, language);
                    mkdirSync(subdir);
                    const mapped = new Map();
                    for (const [p, source] of group) {
                        const name = `${id++}${extensions[0]}`;
                        writeFileSync(path.join(subdir, name), source, { flag: 'wx', mode: 0o600 });
                        mapped.set(name, p);
                        result.set(p, { imports: [], limitations: [], parsed: false });
                    }
                    for (const q of queries(language)) {
                        const stdout = invoke(['run', '--lang', language, ...(q.kind ? ['--kind', q.kind] : ['--pattern', q.pattern]), '--json=compact', '--threads', '2', '--no-ignore', 'hidden', '.'], subdir);
                        const matches = JSON.parse(stdout || '[]');
                        if (!Array.isArray(matches))
                            throw new Error('AST collector output is not an array');
                        for (const m of matches) {
                            const p = mapped.get(path.basename(m.file)), r = result.get(p);
                            if (!r || typeof m.text !== 'string' || !Number.isSafeInteger(m.range?.start?.line))
                                throw new Error('AST output lacks a known source witness');
                            if (q.id === 'root') {
                                r.parsed = true;
                                continue;
                            }
                            if (q.id === 'error') {
                                r.limitations.push({ path: p, reason: `syntax-error at line ${m.range.start.line + 1}` });
                                continue;
                            }
                            const items = decoded(m, q.id, language);
                            if (!items.length)
                                r.limitations.push({ path: p, reason: `unresolved ${q.id} at line ${m.range.start.line + 1}` });
                            for (const item of items)
                                r.imports.push({ ...item, line: m.range.start.line + 1 });
                            if (q.id === 'require')
                                r.limitations.push({ path: p, reason: 'require binding is syntax-only; may be shadowed' });
                        }
                    }
                    for (const p of group.keys()) {
                        const r = result.get(p);
                        if (!r.parsed)
                            r.limitations.push({ path: p, reason: 'native parser did not report a source root' });
                    }
                }
                return result;
            }
            finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
    };
}
