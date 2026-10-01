// Только новые синтетические inputs current owner; реальные samples не создаёт.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const root = '/workspace/lab-motion';
const source = readFileSync(`${root}/test/server-profile-contract.test.ts`, 'utf8')
  .split("describe('серверный PROFILE: clock/progress falsifiers'")[0]
  .replace(/import \{[^\n]+\} from 'vitest';\n/, '').replaceAll("'../bench/", `'${root}/bench/`);
writeFileSync(new URL('./current-fixtures.mjs', import.meta.url), createRequire(`${root}/package.json`)('esbuild')
  .transformSync(`${source}\nexport { stage, healthyAdmission, admissionEvents, syntheticBrowser, syntheticSemanticControl };`,
    { loader: 'ts', target: 'es2022', format: 'esm' }).code);
