export const film = Object.freeze({ duration: 18, fps: 60, width: 1920, height: 1080 });
export const speedKeys = Object.freeze([
  [0, .25], [3, .25], [5.6, .6], [8.6, 3.2], [9.05, 3.2],
  [9.8, .055], [10.8, .055], [13.8, .25], [18, .25],
]);
const clamp = x => Math.max(0, Math.min(1, x));
export const smooth = x => { const u=clamp(x); return u*u*u*(10+u*(-15+6*u)); };
const smoothIntegral = u => u**6 - 3*u**5 + 2.5*u**4;
const lerp = (a,b,u) => a+(b-a)*u;
const cycle = t => ((t % film.duration)+film.duration)%film.duration;

function integratedSpeed(t) {
  let sum=0;
  for(let i=0;i<speedKeys.length-1;i++) {
    const [a,va]=speedKeys[i], [b,vb]=speedKeys[i+1];
    const u=clamp((t-a)/(b-a));
    sum+=(b-a)*(va*u+(vb-va)*smoothIntegral(u));
  }
  return sum;
}
// Exactly 28 bead intervals per film: the visible set joins seamlessly.
const rate = 28/integratedSpeed(film.duration);
export function travelAt(t) { return rate*integratedSpeed(cycle(t)); }
export function speedAt(t) {
  const q=cycle(t);
  for(let i=0;i<speedKeys.length-1;i++) {
    const [a,va]=speedKeys[i], [b,vb]=speedKeys[i+1];
    if(q < b) return rate*lerp(va,vb,smooth((q-a)/(b-a)));
  }
  return rate*speedKeys[0][1];
}

export function cameraAt(t) {
  const q=cycle(t);
  if(q<3) return {scale:lerp(1.1,1.14,smooth(q/3)),x:800,y:450,shot:'whole'};
  if(q<5.6) {
    const u=smooth((q-3)/2.6);
    return {scale:lerp(2.15,2.5,u),x:lerp(930,960,u),y:lerp(450,438,u),shot:'detail'};
  }
  if(q<8.6) {
    const u=smooth((q-5.6)/3);
    return {scale:lerp(1.68,1.86,u),x:lerp(800,836,u),y:450,shot:'acceleration'};
  }
  if(q<10.8) {
    const u=smooth((q-8.6)/1.2);
    return {scale:lerp(4.5,4.7,u),x:lerp(725,735,u),y:345,shot:'climax'};
  }
  if(q<13.8) {
    const u=smooth((q-10.8)/3);
    return {scale:Math.exp(lerp(Math.log(4.7),Math.log(1.14),u)),x:lerp(735,800,u),y:lerp(345,450,u),shot:'return'};
  }
  return {scale:lerp(1.14,1.1,smooth((q-13.8)/4.2)),x:800,y:450,shot:'whole'};
}
