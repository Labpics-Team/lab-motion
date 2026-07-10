import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/easing/index.ts', 'src/react/index.ts', 'src/svelte/index.ts', 'src/vue/index.ts', 'src/value/index.ts', 'src/driver/index.ts', 'src/stagger/index.ts', 'src/timeline/index.ts', 'src/keyframes/index.ts', 'src/decay/index.ts', 'src/lit/index.ts', 'src/gestures/index.ts', 'src/scroll/index.ts', 'src/presence/index.ts', 'src/flip/index.ts', 'src/projection/index.ts', 'src/svg/index.ts', 'src/a11y/index.ts', 'src/spring/index.ts', 'src/waapi/index.ts', 'src/auto/index.ts', 'src/svg-morph/index.ts', 'src/solid/index.ts', 'src/preact/index.ts', 'src/angular/index.ts', 'src/wc/index.ts', 'src/qwik/index.ts', 'src/frame/index.ts', 'src/presets/index.ts', 'src/utils/index.ts', 'src/compositor/index.ts', 'src/tokens/index.ts', 'src/animate/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  terserOptions: { compress: { passes: 3, pure_getters: true }, mangle: { properties: { regex: /^_/ } } },
  treeshake: true,
});
