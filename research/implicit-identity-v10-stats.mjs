export function geometricMean(values) { return Math.exp(values.reduce((s,x)=>s+Math.log(x),0)/values.length); }
function q(values,p){const s=[...values].sort((a,b)=>a-b);if(!s.length)throw new Error('empty');if(p===.5&&s.length%2===0){const i=s.length/2;return(s[i-1]+s[i])/2}return s[Math.min(s.length-1,Math.max(0,Math.ceil(s.length*p)-1))]}
function rng(seed){let s=seed>>>0;return()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/0x100000000}}
export function bootstrap(values,seed,iters){const r=rng(seed),a=[],b=[];for(let k=0;k<iters;k++){const x=Array(values.length);for(let i=0;i<values.length;i++)x[i]=values[Math.floor(r()*values.length)];a.push(q(x,.5));b.push(q(x,.95))}const one=(point,d)=>({point,low:q(d,.025),high:q(d,.975)});return{p50:one(q(values,.5),a),p95:one(q(values,.95),b)}}
export function summarizeClusters(c,seed,iters){return{wall:bootstrap(c.map(x=>x.wallRatio),seed>>>0,iters),cpu:bootstrap(c.map(x=>x.cpuRatio),(seed+0x51ed270b)>>>0,iters)}}
export const nullPass=s=>['wall','cpu'].every(m=>['p50','p95'].every(k=>s[m][k].low>=.95&&s[m][k].high<=1.05));
export const positivePass=s=>['wall','cpu'].every(m=>['p50','p95'].every(k=>s[m][k].low>1.5));
export const abPass=s=>['wall','cpu'].every(m=>['p50','p95'].every(k=>s[m][k].high<=1.05));
