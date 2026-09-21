import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { motionCompiler } from '../dist/compiler/vite/index.js';
import { readCompilerNanoRecipe } from '../scripts/compiler-doc-recipe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAYGROUND_ID = 'virtual:lab-motion-compiler-playground';
const RESOLVED_PLAYGROUND_ID = 'lab-motion:compiler-playground-recipe.js';

function compilerPlaygroundRecipe() {
  return {
    name: 'lab-motion:compiler-playground-recipe',
    enforce: 'pre',
    resolveId(id) {
      return id === PLAYGROUND_ID ? RESOLVED_PLAYGROUND_ID : undefined;
    },
    load(id) {
      return id === RESOLVED_PLAYGROUND_ID ? readCompilerNanoRecipe(ROOT) : undefined;
    },
  };
}

function assertCompilerPlaygroundLowered() {
  return {
    name: 'lab-motion:compiler-playground-proof',
    enforce: 'post',
    transform(code, id) {
      if (id !== RESOLVED_PLAYGROUND_ID) return undefined;
      if (!code.includes('@labpics/motion/compiler/runtime') || !code.includes('__labMotionNanoCompiled')) {
        this.error('compiler playground: буквальный docs-рецепт не был понижен motionCompiler()');
      }
      return undefined;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [compilerPlaygroundRecipe(), motionCompiler(), assertCompilerPlaygroundLowered()],
  build: {
    modulePreload: { polyfill: false },
  },
});
