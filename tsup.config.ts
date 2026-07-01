import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/easing/index.ts', 'src/react/index.ts', 'src/svelte/index.ts', 'src/vue/index.ts', 'src/value/index.ts', 'src/driver/index.ts', 'src/stagger/index.ts', 'src/timeline/index.ts', 'src/keyframes/index.ts', 'src/decay/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  treeshake: true,
});
