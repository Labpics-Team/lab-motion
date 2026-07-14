/**
 * Единый оракул сжатия для размерного гейта и сравнительного S6.
 *
 * Gzip обязан быть одинаковым на всех поддерживаемых Node, поэтому его кодек и
 * параметры закреплены здесь. Brotli остаётся системной метрикой: publish-стенд
 * связывает её с точным Node executable и требует победы в обоих представлениях.
 */

import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { gzip } from 'pako';
import { CANONICAL_GZIP_OPTIONS } from './compression-policy.mjs';

export const canonicalGzip = (bytes) => gzip(bytes, CANONICAL_GZIP_OPTIONS);

export const observationalBrotli = (bytes) =>
  brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  });
