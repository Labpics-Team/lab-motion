import { installCompilerPlayground } from './compiler-playground.js';
import { installShowcase } from './showcase.js';

const disposeShowcase = installShowcase();
const disposeCompilerPlayground = installCompilerPlayground();

const dispose = () => {
  disposeCompilerPlayground();
  disposeShowcase();
};

if (import.meta.hot) import.meta.hot.dispose(dispose);
