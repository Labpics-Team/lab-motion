import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const [dir]=process.argv.slice(2);
const read=name=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
const q=(xs,p)=>{const a=[...xs].sort((x,y)=>x-y),i=(a.length-1)*p,l=Math.floor(i),h=Math.ceil(i);return a[l]+(a[h]-a[l])*(i-l);};
const median=xs=>q(xs,.5);
let seed=0x5eed1234;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
function bootstrapMedianCI(xs){const boots=[];for(let b=0;b<20000;b++){const s=[];for(let i=0;i<xs.length;i++)s.push(xs[Math.floor(rand()*xs.length)]);boots.push(median(s));}return{p50:median(xs),lo:q(boots,.025),hi:q(boots,.975)};}
function summarize(file){
 const cells=new Map();
 for(const block of file.rows){
  for(const path of ['main','waapi'])for(const rowA of block.base[path].rows){
   const rowB=block.candidate[path].rows.find(x=>x.motion===rowA.motion&&x.count===rowA.count);assert(rowB);
   for(const metric of Object.keys(rowA.samples[0])){
    const key=`${path}/${rowA.motion}/${rowA.count}/${metric}`;
    const a=median(rowA.samples.map(x=>x[metric])),b=median(rowB.samples.map(x=>x[metric]));
    (cells.get(key)??cells.set(key,[]).get(key)).push(b/a);
   }
  }
 }
 return Object.fromEntries([...cells].map(([k,v])=>[k,bootstrapMedianCI(v)]));
}
const aa=summarize(read('aa')),double=summarize(read('double')),ab=summarize(read('ab'));
// Product policy mirrors docs/benchmark.md: <=5% p95 non-inferiority. Because
// this Node micro-harness runs on a shared runner, it may be used as a blocking
// proof only when its A/A controls themselves resolve that band. A large 2x-work
// control must also be detected, otherwise a green result would be tautological.
const verdict={pass:true,cells:{}};
for(const key of Object.keys(ab)){
 const baselineResolution=aa[key];const positive=double[key];const candidate=ab[key];
 const resolvable=baselineResolution.lo>=.95&&baselineResolution.hi<=1.05;
 const detectsLargeRegression=positive.lo>1.5;
 const nonInferior=candidate.hi<=1.05;
 const pass=resolvable&&detectsLargeRegression&&nonInferior;
 verdict.cells[key]={aa:baselineResolution,doubleWork:positive,candidate,resolvable,detectsLargeRegression,nonInferior,pass};
 verdict.pass&&=pass;
}
console.log(JSON.stringify(verdict,null,2));
if(!verdict.pass)process.exitCode=1;
