import { mkdir, writeFile } from 'node:fs/promises';
import { spring } from '@labpics/motion';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Укажите каталог для кадров.');
const output = pathToFileURL(resolve(process.argv[2]) + '/');
await mkdir(output, { recursive: true });
const params = { mass: 1, stiffness: 100, damping: 12 };
const count = 25;
function point(i, shape) {
  const a = i / count * Math.PI * 2 - Math.PI / 2;
  if (shape === 0) return [760 + 142 * Math.cos(a), 281 + 142 * Math.sin(a)];
  if (shape === 1) return [640 + (i % 5) * 60, 161 + Math.floor(i / 5) * 60];
  return [620 + i * 12, 281 + Math.sin(i / 24 * Math.PI * 2) * 92];
}
function frame(t) {
  let phase = Math.floor(t / 4) % 3;
  let local = t % 4;
  const labels = ['Собраться.', 'Поймать волну.', 'Вернуться.'];
  let objects = '';
  for (let i = 0; i < count; i++) {
    const progress = local < 0.65 + i * 0.025 ? 0 : local > 3.3 ? 1 : spring(params, local - 0.65 - i * 0.025).value;
    const a = point(i, phase), b = point(i, (phase + 1) % 3);
    const x = a[0] + (b[0] - a[0]) * progress;
    const y = a[1] + (b[1] - a[1]) * progress;
    objects += `<circle cx="${x.toFixed(3)}" cy="${y.toFixed(3)}" r="${i===0?14:10}" fill="${i===0?'#ff8f70':'#a6f4d3'}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#0b0d10"/><g font-family="Arial,Helvetica,sans-serif" fill="#f3f7f5"><text x="48" y="58" font-size="14" letter-spacing="2">LABPICS / MOTION STUDY</text><text x="42" y="247" font-size="80" font-weight="700" letter-spacing="-4">lab motion</text><text x="48" y="299" font-size="25" fill="#aeb9bf">${labels[phase]}</text><text x="48" y="490" font-size="16" fill="#aeb9bf">Пружины. Ритм. Движение.</text><text x="912" y="490" text-anchor="end" font-size="16" fill="#aeb9bf">${String(phase+1).padStart(2,'0')} / 03</text></g>${objects}</svg>`;
}
for (let i = 0; i < 360; i++) await writeFile(new URL(`${String(i).padStart(4,'0')}.svg`,output),frame(i/30));
await writeFile(new URL('poster.svg',output),frame(0));
