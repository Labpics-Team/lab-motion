import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {film,cameraAt} from './preview/timeline.mjs';
import {sampleFilm} from './preview/helix-geometry.mjs';

export function frame(t,{width=film.width,height=film.height,poster=false}={}) {
  const camera=poster?{scale:1.5,x:800,y:445}:cameraAt(t);
  const dots=sampleFilm(t).sort((a,b)=>a.depth-b.depth).map(p=>{
    const near=(p.depth+1)/2,gray=Math.round(152-136*near);
    return `<circle cx="${p.x.toFixed(4)}" cy="${p.y.toFixed(4)}" r="${p.r.toFixed(4)}" fill="rgb(${gray},${gray},${gray})" stroke="white" stroke-width="3" paint-order="stroke fill" opacity="${p.alpha.toFixed(5)}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1600 900" role="img" aria-labelledby="title desc"><title id="title">Lab Motion — пружина из кругов</title><desc id="desc">Круги движутся по виткам пружины, ускоряются и замедляются. Общие планы сменяются крупными; ближние круги крупнее и темнее дальних.</desc><rect width="1600" height="900" fill="white"/><g transform="translate(800 450) scale(${camera.scale.toFixed(6)}) translate(${-camera.x} ${-camera.y})">${dots}</g></svg>`;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const out=process.argv[2]||'/tmp/lab-motion-film';
  await mkdir(out,{recursive:true});
  for(let i=0;i<film.duration*film.fps;i++) await writeFile(`${out}/${String(i).padStart(4,'0')}.svg`,frame(i/film.fps));
  await writeFile(`${out}/poster.svg`,frame(1.5,{poster:true}));
  console.log(JSON.stringify({...film,frames:film.duration*film.fps,output:out}));
}
