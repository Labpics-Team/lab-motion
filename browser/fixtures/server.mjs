/**
 * server.mjs — zero-dep статический http-сервер для browser conformance.
 *
 * Отдаёт repo-root по http, чтобы модульные `import` из СОБРАННОГО dist
 * резолвились по origin. Через file:// Chromium блокировал бы module-fetch
 * соседнего file:// (opaque-origin CORS) — http снимает вопрос целиком.
 *
 * Ноль зависимостей (инвариант пакета). Читает только внутри repo-root
 * (path-traversal отбивается нормализацией). Content-Type для .js — строго
 * text/javascript (Chromium требует JS-MIME для module-script).
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PORT = Number(process.argv[2] ?? 6180);

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    // Нормализуем и удерживаем в ROOT (path-traversal → 403).
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(500).end(String(error?.message ?? error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // Playwright ждёт готовности по url — вывод для локальной диагностики.
  console.log(`browser-conformance server: http://127.0.0.1:${PORT}/ (root ${ROOT})`);
});
