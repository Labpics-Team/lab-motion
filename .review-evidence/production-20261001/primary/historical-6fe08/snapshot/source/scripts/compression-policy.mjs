/**
 * Чистый контракт канонического gzip без загрузки dev-кодека.
 *
 * Consumer-проверки читают benchmark-метаданные без `node_modules`; поэтому
 * имя реализации и параметры отделены от адаптера, который импортирует pako.
 */

export const CANONICAL_GZIP_PACKAGE = 'pako';
export const CANONICAL_GZIP_OPTIONS = Object.freeze({
  level: 9,
  windowBits: 15,
  memLevel: 8,
  strategy: 0,
  legacyHash: false,
});
