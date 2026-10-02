import {createRequire} from 'node:module';
const native=createRequire(import.meta.url)(process.argv[2]);
try{console.log(JSON.stringify({value:native.read()}));}catch(error){console.log(JSON.stringify({code:error.code,message:error.message}));}
