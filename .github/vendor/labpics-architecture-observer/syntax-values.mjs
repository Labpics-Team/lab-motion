// Decode already delimited AST values; never evaluate candidate code/config.
export function withoutComments(source) {
    let out = '', quote = '', block = 0, line = false;
    for (let i = 0; i < source.length; i++) {
        const c = source[i], n = source[i + 1];
        if (line) {
            if (c === '\n') {
                line = false;
                out += c;
            }
            else
                out += ' ';
            continue;
        }
        if (block) {
            if (c === '/' && n === '*') {
                block++;
                out += '  ';
                i++;
            }
            else if (c === '*' && n === '/') {
                block--;
                out += '  ';
                i++;
            }
            else
                out += c === '\n' ? '\n' : ' ';
            continue;
        }
        if (quote) {
            out += c;
            if (c === '\\' && quote !== '`') {
                if (i + 1 < source.length)
                    out += source[++i];
            }
            else if (c === quote)
                quote = '';
            continue;
        }
        if (c === '/' && n === '/') {
            line = true;
            out += '  ';
            i++;
        }
        else if (c === '/' && n === '*') {
            block = 1;
            out += '  ';
            i++;
        }
        else {
            out += c;
            if (['"', "'", '`'].includes(c))
                quote = c;
        }
    }
    return out;
}
export function jsonc(source) {
    const input = withoutComments(source);
    let out = '', quote = false;
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (quote) {
            out += c;
            if (c === '\\') {
                if (i + 1 < input.length)
                    out += input[++i];
            }
            else if (c === '"')
                quote = false;
        }
        else if (c === '"') {
            quote = true;
            out += c;
        }
        else if (c === ',' && /^\s*[}\]]/.test(input.slice(i + 1)))
            out += ' ';
        else
            out += c;
    }
    return JSON.parse(out);
}
export function stringValue(source) {
    if (typeof source !== 'string' || source.length < 2)
        return null;
    const q = source[0];
    if (!["'", '"', '`'].includes(q) || source.at(-1) !== q)
        return null;
    const body = source.slice(1, -1);
    if (q === '`')
        return body.includes('${') || /[\r\n\\]/.test(body) ? null : body;
    let result = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c !== '\\') {
            if (c === q || /[\r\n]/.test(c))
                return null;
            result += c;
            continue;
        }
        const e = body[++i];
        if (e === 'x') {
            const h = body.slice(i + 1, i + 3);
            if (!/^[0-9a-f]{2}$/i.test(h))
                return null;
            result += String.fromCharCode(parseInt(h, 16));
            i += 2;
        }
        else if (e === 'u') {
            const m = /^(?:\{([0-9a-f]{1,6})\}|([0-9a-f]{4}))/i.exec(body.slice(i + 1));
            if (!m)
                return null;
            const v = parseInt(m[1] ?? m[2], 16);
            if (v > 0x10ffff)
                return null;
            result += String.fromCodePoint(v);
            i += m[0].length;
        }
        else if (["'", '"', '\\', '/'].includes(e))
            result += e;
        else
            return null;
    }
    return /[\x00-\x1f\x7f]/.test(result) ? null : result;
}
export function rustUsePaths(source) {
    const input = withoutComments(source), token = /r#[\p{ID_Start}_][\p{ID_Continue}_]*|[\p{ID_Start}_][\p{ID_Continue}_]*|::|[{},*]/gu;
    const tokens = input.match(token) ?? [];
    if (input.replace(token, '').trim())
        return [];
    let i = 0;
    const out = [];
    function tree(prefix, depth = 0) {
        if (depth > 128)
            throw new Error('Rust use nesting budget exceeded');
        let parts = [...prefix];
        if (tokens[i] === '::') {
            parts = [''];
            i++;
        }
        while (i < tokens.length) {
            const t = tokens[i++];
            if (t === '{') {
                while (i < tokens.length && tokens[i] !== '}') {
                    tree(parts, depth + 1);
                    if (tokens[i] === ',')
                        i++;
                    else if (tokens[i] !== '}')
                        throw new SyntaxError('Unresolved Rust use tree');
                }
                if (tokens[i++] !== '}')
                    throw new SyntaxError('Unclosed Rust use tree');
                return;
            }
            if ([',', '}', '::'].includes(t))
                throw new SyntaxError('Unresolved Rust path');
            if (t !== 'self' || !parts.length)
                parts.push(t.replace(/^r#/, ''));
            if (tokens[i] === '::') {
                i++;
                continue;
            }
            if (tokens[i] === 'as')
                i += 2;
            out.push(parts.join('::'));
            return;
        }
        throw new SyntaxError('Incomplete Rust path');
    }
    try {
        tree([]);
    } catch (error) {
        // Incomplete code is normal input to an observer. Keep a local unresolved
        // witness, but never downgrade exhausted resources or implementation bugs.
        if (error instanceof SyntaxError)
            return [];
        throw error;
    }
    return i === tokens.length ? out : [];
}
