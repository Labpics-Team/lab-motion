import {prepareServerThreadCpuClock,readServerThreadCpuEndpoint} from '/workspace/lab-motion/bench/profile/server-thread-cpu-clock.mjs';
const prepared=prepareServerThreadCpuClock({directory:process.argv[2]});
const first=readServerThreadCpuEndpoint(),second=readServerThreadCpuEndpoint();
prepared.assertUnchanged();
console.log(JSON.stringify({metadata:prepared.metadata,first,second,identity:first.pid===process.pid&&first.tid===process.pid,monotone:BigInt(second.valueNs)>=BigInt(first.valueNs)},null,2));
