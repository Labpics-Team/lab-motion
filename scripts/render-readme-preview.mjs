import { mkdir, writeFile } from 'node:fs/promises';
import { spring } from '@labpics/motion';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// Соответствие точек между фигурами сохраняет раздельные траектории.
const shapes = [[[0.0, -145.0], [72.5, -125.573684], [125.573684, -72.5], [145.0, 0.0], [125.573684, 72.5], [72.5, 125.573684], [0.0, 145.0], [-72.5, 125.573684], [-125.573684, 72.5], [-145.0, 0.0], [-125.573684, -72.5], [-72.5, -125.573684]], [[-44.0, -88.0], [44.0, -88.0], [132.0, -88.0], [132.0, 0.0], [44.0, 0.0], [132.0, 88.0], [44.0, 88.0], [-44.0, 88.0], [-132.0, 88.0], [-132.0, 0.0], [-132.0, -88.0], [-44.0, 0.0]], [[20.0, -19.721279], [100.0, -69.287501], [140.0, -63.67424], [180.0, -37.844857], [60.0, -52.90247], [220.0, -0.0], [-20.0, 19.721279], [-100.0, 69.287501], [-140.0, 63.67424], [-180.0, 37.844857], [-220.0, 0.0], [-60.0, 52.90247]]];
if (!process.argv[2]) throw new Error('Укажите каталог для кадров.');
const output = pathToFileURL(resolve(process.argv[2]) + '/');
await mkdir(output, { recursive: true });
const order = [0, 1, 2, 1, 0];
const params = { mass: 1, stiffness: 100, damping: 16 };
export function positions(t) {
 const phase = Math.floor(t / 3) % 4;
 const elapsed = t % 3 - 0.4;
 const p = elapsed <= 0 ? 0 : elapsed >= 2.2 ? 1 : spring(params,elapsed).value;
 return shapes[order[phase]].map(([x,y],i)=>{
  const next=shapes[order[phase+1]][i];
  return [480+x+(next[0]-x)*p,315+y+(next[1]-y)*p];
 });
}
export function frame(t) {
 const dots=positions(t).map(([x,y],i)=>`<circle cx="${x.toFixed(3)}" cy="${y.toFixed(3)}" r="10" fill="${i===0?'#407ff2':'#60646c'}"/>`).join('');
 return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby="title desc"><title id="title">Lab Motion</title><desc id="desc">Анимации на пружинах</desc><rect width="960" height="540" fill="#ffffff"/><g font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Arial,sans-serif"><text x="48" y="74" font-size="36" font-weight="600" letter-spacing="-0.7" fill="#1c1d1f">Lab Motion</text><text x="48" y="110" font-size="20" fill="#5d5d5d">Анимации на пружинах</text></g>${dots}</svg>`;
}
for (let i=0;i<360;i++) await writeFile(new URL(`${String(i).padStart(4,'0')}.svg`,output),frame(i/30));
await writeFile(new URL('poster.svg',output),frame(0));
