import { travelAt } from './timeline.mjs';

const tau=2*Math.PI;
export const geometry=Object.freeze({count:112,length:1080,radius:154,coils:5.35,depthSkew:.49,axisSlope:-.042,frontRadius:8.2,backRadius:3.8,tipFade:.022,startAngle:.32});
const fract=x=>x-Math.floor(x);
const smooth=x=>{const u=Math.max(0,Math.min(1,x));return u*u*(3-2*u);};
// One front bead arrives at the central bend during the held close-up.
const target=(3*Math.PI/4+4*Math.PI-geometry.startAngle)/(tau*geometry.coils);
const seed=fract((target*geometry.count-travelAt(9.9)))/geometry.count;

export function sampleFilm(t) {
  const g=geometry, offset=travelAt(t)/g.count+seed;
  return Array.from({length:g.count},(_,id)=>{
    const u=fract(id/g.count+offset),theta=tau*g.coils*u+g.startAngle;
    const depth=Math.sin(theta),near=(depth+1)/2,axis=g.length*(u-.5);
    return {id,u,depth,x:800+axis+g.radius*g.depthSkew*depth,
      y:450+g.radius*Math.cos(theta)+g.axisSlope*axis,
      r:g.backRadius+(g.frontRadius-g.backRadius)*near,
      alpha:smooth(u/g.tipFade)*smooth((1-u)/g.tipFade)};
  });
}
