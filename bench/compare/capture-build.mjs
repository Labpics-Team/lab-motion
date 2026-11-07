import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function captureBuild(root, output) {
  const runtime = path.join(root, 'src/motion/runtime.ts');
  const original = readFileSync(runtime, 'utf8').replace(/\r\n/g, '\n');
  const observer = fileURLToPath(new URL('./capture-boundaries.mjs', import.meta.url));
  const substitutions = [
    ["const text = style.getPropertyValue('transform');", "const text = captureBoundary('transformProperty', () => style.getPropertyValue('transform'));"],
    ["    const matrix = new DOMMatrixReadOnly(text);", "    return captureBoundary('matrixDecode', () => {\n    const matrix = new DOMMatrixReadOnly(text);"],
    ["    return values;\n  }\n  // Headless", "    return values;\n    });\n  }\n  // Headless"],
    ['initialTransforms(this._engine._host.styles(this._element))', "initialTransforms(captureBoundary('styles', () => this._engine._host.styles(this._element)))"],
  ];
  let instrumented = original;
  for (const [before, after] of substitutions) {
    if (instrumented.split(before).length !== 2) throw new Error('Capture boundary source anchor is not unique: ' + before);
    instrumented = instrumented.replace(before, after);
  }
  instrumented = 'import { captureBoundary } from ' + JSON.stringify(observer) + ';\n' + instrumented;
  const generated = path.join(output, 'capture-build');
  mkdirSync(generated, { recursive: true });
  writeFileSync(path.join(generated, 'runtime.original.ts'), original);
  writeFileSync(path.join(generated, 'runtime.instrumented.ts'), instrumented);
  writeFileSync(path.join(generated, 'observer.mjs'), readFileSync(observer));
  const loads = [];
  const manifest = {
    originalPath: 'src/motion/runtime.ts', originalSha256: hash(original),
    instrumentedSha256: hash(instrumented), observerSha256: hash(readFileSync(observer)),
    substitutions, policy: 'build-local module replacement; production files and dist are not overwritten',
  };
  return { observer, plugin: {
    name: 'disposable-s2-capture-boundaries',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]motion[\\/]runtime\.ts$/ }, args => {
        if (path.resolve(args.path) !== path.resolve(runtime)) throw new Error('Unexpected runtime instrumentation path');
        const inputSha256 = hash(readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n'));
        if (inputSha256 !== manifest.originalSha256) throw new Error('Runtime source changed during instrumentation');
        loads.push({ resolvedPath: path.resolve(args.path), inputSha256, suppliedSha256: hash(instrumented) });
        return { contents: instrumented, loader: 'ts', resolveDir: path.dirname(runtime) };
      });
      build.onEnd(result => {
        writeFileSync(path.join(generated, 'manifest.json'), JSON.stringify({ ...manifest, loads,
          engaged: loads.length === 1 && result.errors.length === 0 }, null, 2));
        if (loads.length !== 1) throw new Error('Expected exactly one instrumented runtime load; got ' + loads.length);
      });
    },
  } };
}
