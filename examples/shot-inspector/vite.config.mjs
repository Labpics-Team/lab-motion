import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root, build: { outDir: resolve(root, 'dist'), emptyOutDir: true } });
