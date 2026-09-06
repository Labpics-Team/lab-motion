import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const dir=new URL('./package/dist/animate/',import.meta.url);
const source=await readFile(new URL('index.js',dir),'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'dad58f89598c9157e1476aa0a659e09f26b5ae4afe37db398ad7dd2d3e5fe7d1','exact measured animate input');
const fields='Qt={p:0,H:0,T:0,J:0};';
assert.equal(source.split(fields).length,2,'known immutable SurfaceBatch field');
// Research-only derivation from the shipped module. The native spring formulas
// remain the original Ut implementation; no second under/critical/over solver.
const injected=source.replace(fields,fields+'__phase=phaseState();');
const helper=`
function phaseState(){return {time:NaN,spring:undefined,alpha:0,k:0,steps:new Float64Array(10),count:0,next:0,oracle:{ti:undefined,ii:NaN,Qt:{p:0,H:0,T:0,J:0}},direct:0,transport:0,stepSolves:0,subnormal:0};}
`;
const proto=`
const directBasis = Yt.prototype.Ut;
function sameSpring(p,q){return q!==undefined&&(p===q||(p.mass===q.mass&&p.stiffness===q.stiffness&&p.damping===q.damping));}
const MIN_NORMAL = 2**-1022;
Yt.prototype.Ut=function(p,t){
  const previous=this.ti;
  if(t===this.ii&&sameSpring(p,previous))return this.Qt;
  const s=this.__phase;
  const same=sameSpring(p,previous);
  const h=this.ii-t;
  // Only move along a decreasing stagger run. A new frame/jump/parameter
  // gets a fresh exact anchor; the public clock is never quantized.
  let allowed=same&&t>0&&h>0&&Number.isFinite(h);
  if(GUARDED && allowed && ((Math.abs(this.Qt.H)<MIN_NORMAL)||(Math.abs(this.Qt.J)<MIN_NORMAL))){s.subnormal++;allowed=false;}
  if(allowed){
    let j=-1;
    for(let i=0;i<s.count;i++)if(s.steps[i*5]===h){j=i*5;break;}
    if(j<0){
      const q=directBasis.call(s.oracle,p,h);
      s.stepSolves++;
      const det=Math.exp(-s.alpha*h);
      if(det>0&&Number.isFinite(det)){
        j=s.next*5;s.next=(s.next+1)%2;s.count=Math.min(2,s.count+1);
        s.steps[j]=h;s.steps[j+1]=q.J/det;s.steps[j+2]=-q.H/det;
        s.steps[j+3]=q.T/det;s.steps[j+4]=(q.J+s.alpha*q.H)/det;
      }
    }
    if(j>=0){
      const b=this.Qt,oldS=b.H,oldD=b.J;
      const S=s.steps[j+1]*oldS+s.steps[j+2]*oldD;
      const D=s.steps[j+3]*oldS+s.steps[j+4]*oldD;
      const value=1-(D+s.alpha*S),velocity=s.k*S;
      if(!GUARDED || (Number.isFinite(value)&&Number.isFinite(velocity)&&Number.isFinite(S)&&Number.isFinite(D))){
        b.p=value;b.T=velocity;b.H=S;b.J=D;
        this.ti=p;this.ii=t;s.transport++;return b;
      }
    }
  }
  if(!same){s.alpha=p.damping/p.mass;s.k=p.stiffness/p.mass;s.count=0;s.next=0;s.oracle.ti=undefined;}
  s.direct++;
  return directBasis.call(this,p,t);
};
export {Yt as SurfaceBatch,It as MainUnit,directBasis};
`;
await writeFile(new URL('research-baseline.mjs',dir),source+'\nexport {Yt as SurfaceBatch,It as MainUnit};\n');
for(const [name,guard] of [['unguarded',false],['guarded',true]]){
 await writeFile(new URL(`research-${name}.mjs`,dir),helper+injected+proto.replaceAll('GUARDED',String(guard)));
}
const forwardProto=proto.replaceAll('GUARDED','true')
.replace('let allowed=same&&t>0&&h>0&&Number.isFinite(h);','let allowed=s.active&&!s.anchor&&same&&t>0&&h>0&&Number.isFinite(h);s.anchor=false;')
.replace('if(true && allowed && ((Math.abs(this.Qt.H)<MIN_NORMAL)||(Math.abs(this.Qt.J)<MIN_NORMAL))){s.subnormal++;allowed=false;}','')
.replace('const h=this.ii-t;','const h=t-this.ii;')
.replace('s.steps[j+1]=q.J/det;s.steps[j+2]=-q.H/det;','s.steps[j+1]=q.J+s.alpha*q.H;s.steps[j+2]=q.H;')
.replace('s.steps[j+3]=q.T/det;s.steps[j+4]=(q.J+s.alpha*q.H)/det;','s.steps[j+3]=-q.T;s.steps[j+4]=q.J;')
.replace('const det=Math.exp(-s.alpha*h);','const det=1;');
const reversePure=`
// Research-only scheduler experiment. The shipped interface has no purity
// marker; this classifier inspects the known MainUnit snapshot. It is NOT a
// proposed cross-module production contract.
Yt.prototype.li=function(ts){
 this.ri=this.Jt.length;this.__phase.active=true;this.__phase.anchor=true;
 for(let i=0;i<this.ri;){
   const unit=this.Jt[i];
   if(unit && unit.it?.kt.Nt==='spring'){
     let end=i+1;
     while(end<this.ri && this.Jt[end]?.it?.kt.Nt==='spring')end++;
     for(let j=end-1;j>=i;j--){const u=this.Jt[j];if(u)try{u.Dt(ts)}catch{try{u.Ct()}catch{}}}
     i=end;
   }else{if(unit)try{unit.Dt(ts)}catch{try{unit.Ct()}catch{}}i++;}
 }
 this.__phase.active=false;
 if(this.et===0){this.ri=-1;this.ui();}
};
`;
await writeFile(new URL('research-forward.mjs',dir),helper+injected+forwardProto+reversePure);
// Timing variant has no diagnostic increments or unused diagnostic state.
const release=(helper+injected+forwardProto+reversePure)
 .replace('time:NaN,spring:undefined,','active:false,anchor:false,')
 .replace(',direct:0,transport:0,stepSolves:0,subnormal:0','')
 .replaceAll('s.stepSolves++;','').replaceAll('s.transport++;','').replaceAll('s.direct++;','');
await writeFile(new URL('research-forward-release.mjs',dir),release);
