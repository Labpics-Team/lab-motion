import path from 'node:path';
import { GRAPH_SCHEMA, TOOL_VERSION, compareText, graphEligible, unique, within } from './model.mjs';
import { languageFor } from './native-syntax.mjs';
import { jsonc } from './syntax-values.mjs';
const p = path.posix;
const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
function ancestors(file) {
    const dirs = [];
    let dir = p.dirname(file);
    while (true) {
        dirs.push(dir === '.' ? '' : dir);
        if (dir === '.')
            break;
        dir = p.dirname(dir);
    }
    return dirs;
}
function safeJoin(dir, relative) { const resolved = p.normalize(p.join(dir, relative)); return resolved === '..' || resolved.startsWith('../') || p.isAbsolute(resolved) ? null : resolved; }
function resolveFile(base, paths, extensions = JS_EXTENSIONS) {
    if (!base)
        return null;
    const ext = p.extname(base), candidates = [];
    if (['.js', '.mjs', '.cjs'].includes(ext))
        for (const suffix of JS_EXTENSIONS.slice(0, 4))
            candidates.push(base.slice(0, -ext.length) + suffix);
    candidates.push(base);
    // A dot may belong to a module's basename: foo.config resolves to
    // foo.config.ts. Only a recognized source extension stops extension probing.
    if (!extensions.includes(ext))
        for (const suffix of extensions)
            candidates.push(base + suffix);
    for (const suffix of extensions)
        candidates.push(`${base}/index${suffix}`);
    return candidates.find(c => paths.has(c)) ?? null;
}
function packageRoot(specifier) { return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]; }
function manifests(files) {
    const packages = [];
    for (const [file, source] of files)
        if (p.basename(file) === 'package.json') {
            try {
                const data = JSON.parse(source);
                if (typeof data.name === 'string')
                    packages.push({ file, data, dir: p.dirname(file) });
            }
            catch { /* Invalid candidates surface at their consumer, never execute. */ }
        }
    return packages;
}
function tsOptions(file, files, seen = new Set()) {
    if (seen.size >= 32 || seen.has(file))
        throw new Error('cyclic or deep tsconfig extends');
    seen.add(file);
    const source = files.get(file);
    if (source === undefined)
        throw new Error('missing tsconfig');
    const data = jsonc(source);
    let inherited = { aliases: [], base: null, limitations: [] };
    if (data.extends !== undefined) {
        if (typeof data.extends !== 'string' || !data.extends.startsWith('.'))
            inherited.limitations.push('non-local or multiple tsconfig extends is not resolved');
        else {
            const base = safeJoin(p.dirname(file), data.extends);
            inherited = tsOptions(files.has(base) ? base : `${base}.json`, files, seen);
        }
    }
    const options = data.compilerOptions ?? {}, dir = p.dirname(file), base = typeof options.baseUrl === 'string' ? safeJoin(dir, options.baseUrl) : inherited.base;
    const aliasBase = base ?? dir;
    if (options.paths !== undefined) {
        if (!options.paths || typeof options.paths !== 'object' || Array.isArray(options.paths))
            throw new Error('invalid compilerOptions.paths');
        inherited.aliases = Object.entries(options.paths).map(([key, values]) => {
            if (key.split('*').length > 2 || !Array.isArray(values) || values.some(v => typeof v !== 'string' || v.split('*').length > 2))
                throw new Error('unsupported path alias');
            return { key, values, base: aliasBase };
        });
    }
    return { ...inherited, base };
}
function resolverContext(snapshot, sourcePaths, limitations) {
    const files = snapshot.files, paths = new Set(sourcePaths), packages = manifests(files), options = new Map(), goModules = [];
    for (const [file, source] of files)
        if (p.basename(file) === 'go.mod') {
            const name = source.match(/^\s*module\s+(?:"([^"]+)"|(\S+))\s*$/m);
            if (name)
                goModules.push({ name: name[1] ?? name[2], dir: p.dirname(file) === '.' ? '' : p.dirname(file) });
        }
    const tsFor = file => {
        const config = ancestors(file).flatMap(dir => [p.join(dir, 'tsconfig.json'), p.join(dir, 'jsconfig.json')]).find(f => files.has(f));
        if (!config)
            return { aliases: [], base: null, limitations: [] };
        if (!options.has(config)) {
            try {
                options.set(config, tsOptions(config, files));
            }
            catch {
                options.set(config, { aliases: [], base: null, limitations: ['tsconfig could not be resolved'] });
            }
        }
        const value = options.get(config);
        for (const reason of value.limitations)
            limitations.push({ path: file, reason });
        return value;
    };
    function js(specifier, file) {
        if (specifier.startsWith('.'))
            return { target: resolveFile(safeJoin(p.dirname(file), specifier), paths) };
        if (specifier.startsWith('node:'))
            return { external: `external:node:${specifier.slice(5)}` };
        const config = tsFor(file);
        const matched = config.aliases.flatMap(a => {
            const [start, end] = a.key.split('*');
            if (end === undefined)
                return specifier === a.key ? [{ ...a, star: '' }] : [];
            return specifier.startsWith(start) && specifier.endsWith(end) ? [{ ...a, star: specifier.slice(start.length, specifier.length - end.length) }] : [];
        }).sort((a, b) => b.key.replace('*', '').length - a.key.replace('*', '').length);
        if (matched.length) {
            const a = matched[0];
            for (const value of a.values) {
                const target = resolveFile(safeJoin(a.base, value.replace('*', a.star)), paths);
                if (target)
                    return { target };
            }
            return { target: null };
        }
        if (config.base) {
            const target = resolveFile(safeJoin(config.base, specifier), paths);
            if (target)
                return { target };
        }
        const local = packages.filter(m => specifier === m.data.name || specifier.startsWith(`${m.data.name}/`));
        if (local.length) {
            if (local.length !== 1)
                return { target: null };
            const m = local[0], suffix = specifier.slice(m.data.name.length), key = suffix ? '.' + suffix : '.';
            const exported = typeof m.data.exports === 'string' && key === '.' ? m.data.exports : m.data.exports?.[key];
            const entry = exported ?? (!suffix ? (m.data.types ?? m.data.module ?? m.data.main) : null);
            return { target: typeof entry === 'string' ? resolveFile(safeJoin(m.dir, entry), paths) : null };
        }
        if (specifier.startsWith('#') || specifier.startsWith('/') || config.limitations.length)
            return { target: null };
        return { external: `external:npm:${packageRoot(specifier)}` };
    }
    function go(specifier) {
        const roots = goModules.filter(m => specifier === m.name || specifier.startsWith(`${m.name}/`)).sort((a, b) => b.name.length - a.name.length);
        if (!roots.length)
            return { external: `external:go:${specifier}` };
        const m = roots[0], dir = safeJoin(m.dir, specifier.slice(m.name.length).replace(/^\//, ''));
        const members = sourcePaths.filter(f => f.endsWith('.go') && (p.dirname(f) === '.' ? '' : p.dirname(f)) === (dir === '.' ? '' : dir));
        return members.length ? { targets: members } : { target: null };
    }
    function rust(specifier, file) {
        const cargo = ancestors(file).map(dir => p.join(dir, 'Cargo.toml')).find(f => files.has(f));
        let root = cargo ? p.join(p.dirname(cargo), 'src') : file.includes('/src/') ? file.slice(0, file.indexOf('/src/') + 4) : 'src';
        const parts = specifier.replace(/^::/, '').split('::').filter(Boolean);
        if (parts[0] === 'crate')
            parts.shift();
        else if (parts[0] === 'self' || parts[0] === 'super') {
            const stem = p.basename(file, '.rs');
            root = ['lib', 'main', 'mod'].includes(stem) ? p.dirname(file) : p.join(p.dirname(file), stem);
            if (parts[0] === 'self')
                parts.shift();
            while (parts[0] === 'super') {
                root = p.dirname(root);
                parts.shift();
            }
        }
        else {
            const first = parts[0];
            if (!first)
                return { target: null };
            if (!paths.has(p.join(root, `${first}.rs`)) && !paths.has(p.join(root, first, 'mod.rs')))
                return { external: `external:cargo:${first}` };
        }
        if (parts.length && parts.at(-1) === '*')
            parts.pop();
        while (parts.length) {
            const base = p.join(root, ...parts);
            for (const target of [`${base}.rs`, `${base}/mod.rs`])
                if (paths.has(target))
                    return { target };
            parts.pop();
        }
        for (const target of [`${root}.rs`, `${root}/mod.rs`, `${root}/lib.rs`, `${root}/main.rs`])
            if (paths.has(target))
                return { target };
        return { target: null };
    }
    function python(specifier, file) {
        let base;
        if (specifier.startsWith('.')) {
            const dots = specifier.match(/^\.+/)[0].length;
            let dir = p.dirname(file);
            for (let i = 1; i < dots; i++)
                dir = p.dirname(dir);
            base = safeJoin(dir, specifier.slice(dots).replaceAll('.', '/'));
        }
        else
            base = specifier.replaceAll('.', '/');
        if (base)
            for (const target of [`${base}.py`, `${base}/__init__.py`])
                if (paths.has(target))
                    return { target };
        return specifier.startsWith('.') ? { target: null } : { external: `external:python:${specifier.split('.')[0]}` };
    }
    return (specifier, file) => { const lang = languageFor(file); return ['TypeScript', 'Tsx', 'JavaScript'].includes(lang) ? js(specifier, file) : lang === 'Go' ? go(specifier) : lang === 'Rust' ? rust(specifier, file) : python(specifier, file); };
}
export function buildSourceGraph(snapshot, config, syntax = null) {
    const sourcePaths = snapshot.entries.filter(e => graphEligible(e.path, config)).map(e => e.path).sort(compareText), readPaths = sourcePaths.filter(f => snapshot.files.has(f));
    const nodes = sourcePaths.map(f => ({ id: f, external: false, paths: [f], basis: 'source-file' })), edges = [], limitations = [];
    const input = new Map(readPaths.map(f => [f, snapshot.files.get(f)]));
    const parsed = syntax ? syntax.collect(input) : new Map();
    const resolve = resolverContext(snapshot, sourcePaths, limitations), externals = new Set();
    let parsedFiles = 0;
    for (const file of sourcePaths) {
        const result = parsed.get(file);
        if (!result?.parsed) {
            limitations.push({ path: file, reason: !snapshot.files.has(file) ? 'source blob omitted from bounded snapshot' : !languageFor(file) ? 'unsupported language' : syntax ? 'native parser did not qualify source' : 'native syntax collector not supplied' });
            continue;
        }
        parsedFiles++;
        limitations.push(...result.limitations);
        for (const item of result.imports) {
            const resolved = resolve(item.specifier, file);
            const targets = resolved.external ? [resolved.external] : resolved.targets ?? (resolved.target ? [resolved.target] : []);
            if (!targets.length) {
                limitations.push({ path: file, reason: `unresolved ${item.kind} at line ${item.line}` });
                continue;
            }
            if (resolved.external)
                externals.add(resolved.external);
            for (const to of targets)
                if (to !== file)
                    edges.push({ from: file, to, kind: item.kind, path: file, line: item.line });
        }
    }
    for (const id of externals)
        nodes.push({ id, external: true, paths: [], basis: 'external-import' });
    // A syntactic import graph never certifies semantic absence (macros, generated
    // modules, cfg, runtime loading and shadowed names require stronger sensors).
    limitations.push({ path: null, reason: 'import-syntax evidence only; compiler binding, code generation, conditional builds and runtime loading are not certified' });
    const dedup = new Map();
    for (const e of edges)
        dedup.set(JSON.stringify(e), e);
    const uniqueLimits = new Map(limitations.map(l => [JSON.stringify(l), l]));
    return { schema: GRAPH_SCHEMA, commit: snapshot.commit, producer: syntax?.producer ?? { name: 'unavailable-source-graph', version: TOOL_VERSION }, nodes: nodes.sort((a, b) => compareText(a.id, b.id)), edges: [...dedup].sort(([a], [b]) => compareText(a, b)).map(([, e]) => e), limitations: [...uniqueLimits.values()],
        coverage: { sourceFiles: sourcePaths.length, parsedFiles, ratio: sourcePaths.length ? parsedFiles / sourcePaths.length : 0, omittedSnapshotFiles: snapshot.omitted.length, complete: false } };
}
