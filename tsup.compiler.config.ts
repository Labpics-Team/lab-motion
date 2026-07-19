/**
 * Вторая, ПОСЛЕДОВАТЕЛЬНАЯ сборка build-tool entries (#208): собственный
 * DTS-воркер для тип-графа MotionProgram V1 (см. комментарий в tsup.config.ts).
 * Запускается после основной: `tsup && tsup --config tsup.compiler.config.ts`.
 */
import { defineConfig } from 'tsup';
import { compilerEntries, sharedEmit } from './tsup.config.js';

export default defineConfig({
  ...sharedEmit(),
  entry: compilerEntries,
  clean: false,
});
