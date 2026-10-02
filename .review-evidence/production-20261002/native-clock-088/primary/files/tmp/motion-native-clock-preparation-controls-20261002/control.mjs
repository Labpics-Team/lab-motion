import {prepareServerThreadCpuClock} from '/workspace/lab-motion/bench/profile/server-thread-cpu-clock.mjs';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
const mode=process.argv[2],directory=process.argv[3];
if(mode==='worker'){
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');import('/workspace/lab-motion/bench/profile/server-thread-cpu-clock.mjs').then(({prepareServerThreadCpuClock})=>{try{prepareServerThreadCpuClock({directory:${JSON.stringify(directory)}});parentPort.postMessage({accepted:true});}catch(error){parentPort.postMessage({message:error.message,raw:error.raw});}});`,{eval:true});
 console.log(JSON.stringify(await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})));await worker.terminate();
}else{
 if(mode==='nonlinux')Object.defineProperty(process,'platform',{value:'darwin'});
 if(mode==='wrong-node')Object.defineProperty(process,'version',{value:'v24.19.1'});
 if(mode==='missing-compiler')process.env.PATH='';
 if(mode==='stale-binary'){mkdirSync(directory+'/native-clock',{recursive:true});writeFileSync(directory+'/native-clock/thread-cpu-clock.node','stale');}
 try{
  const prepared=prepareServerThreadCpuClock({directory});
  if(mode==='binary-mutation'){appendFileSync(prepared.metadata.nativeBinary.path,'mutation');prepared.assertUnchanged();}
  console.log(JSON.stringify({accepted:true}));
 }catch(error){console.log(JSON.stringify({message:error.message,raw:error.raw}));}
}
