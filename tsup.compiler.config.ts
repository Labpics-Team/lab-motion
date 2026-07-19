/**
 * Вторая, ПОСЛЕДОВАТЕЛЬНАЯ сборка build-tool entries (#208): собственный
 * DTS-воркер для тип-графа MotionProgram V1 (см. комментарий в tsup.config.ts).
 * Запускается после основной: `tsup && tsup --config tsup.compiler.config.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';
import { compilerEntries, sharedEmit } from './tsup.config.js';

/**
 * У этой сборки нет sharedFramePlugin/onSuccess первой: compiler-граф не
 * имеет права дотянуться до frame-scheduler (второй inlined rAF-цикл в
 * браузерном ./compiler/runtime — ровно тот дубль, от которого plugin
 * защищает). Инвариант проверяется явно после эмита.
 */
async function assertNoFrameInCompilerDist(): Promise<void> {
  const root = join('dist', 'compiler');
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(file); continue; }
      const source = readFileSync(file, 'utf8');
      if (source.includes('#frame') || source.includes('requestAnimationFrame')) {
        throw new Error(`build: compiler-граф дотянулся до frame-scheduler: ${file}`);
      }
    }
  }
}

export default defineConfig({
  ...sharedEmit(),
  entry: compilerEntries,
  clean: false,
  onSuccess: assertNoFrameInCompilerDist,
});
