import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
export async function serveDist(roots) {
const server=createServer((req,res)=>{
 try {
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html>');}
  const [,name,...parts]=new URL(req.url,'http://localhost').pathname.split('/');
  const root=roots[name],file=realpathSync(resolve(root,...parts)),rel=relative(root,file);
  if(rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw Error('path');
  res.setHeader('Content-Type','text/javascript');res.end(readFileSync(file));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
return server;
}
