import { installShowcase } from './showcase.js';

const dispose = installShowcase();

if (import.meta.hot) import.meta.hot.dispose(dispose);
