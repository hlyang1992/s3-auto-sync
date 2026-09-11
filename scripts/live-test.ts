import { fromRemotelySave } from './legacy-config.ts';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,readdir,rm,stat } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaults,digest,syncPath,validateConfig } from '../src/model.ts';
import type { Config,LocalFiles,Snapshot,State } from '../src/model.ts';
import { SyncEngine } from '../src/engine.ts';
import { S3Store } from '../src/s3.ts';

// All data is synthetic. Refuse to run against a bucket not explicitly named for tests.
let config:Config;
if(process.env.S3_TEST_CONFIG) config=validateConfig({...defaults,...JSON.parse(await readFile(process.env.S3_TEST_CONFIG,'utf8'))});
else {
  const target=JSON.parse(await readFile('.private/target.json','utf8')) as {sourcePath:string;bucket:string};
  const source=fromRemotelySave(JSON.parse(await readFile(target.sourcePath,'utf8')));
  assert.notEqual(target.bucket,source.bucket,'Refusing the production bucket');
  config={...source,bucket:target.bucket,prefix:'',pathStyle:true};
}
assert.match(config.bucket,/^s3-auto-sync-test-/,'Only s3-auto-sync-test-* buckets are accepted');
const run='run-'+new Date().toISOString().replace(/[:.]/g,'-');
const root=resolve('.private',run);await mkdir(root,{recursive:true,mode:0o700});
let offline=false,requests=0;
const transport:ConstructorParameters<typeof S3Store>[1]=async req=>{
  if(offline)throw Error('simulated disconnection');requests++;
  const r=await fetch(req.url,{method:req.method,headers:req.headers,body:req.body,signal:AbortSignal.timeout(30_000)});
  return {status:r.status,headers:Object.fromEntries(r.headers),bytes:new Uint8Array(await r.arrayBuffer())};
};
const records:{name:string;passed:boolean;durationMs:number;error?:string}[]=[];
const content=(s:string)=>new TextEncoder().encode(s);
class DiskLocal implements LocalFiles {
  constructor(private root:string){}
  path(p:string){assert(syncPath(p));const target=resolve(this.root,p);assert(target.startsWith(this.root+'/'));return target;}
  async paths(){const walk=async(dir:string):Promise<string[]>=>{const out:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.isFile())out.push(p.slice(this.root.length+1));}return out;};return walk(this.root);}
  async read(p:string){try{const b=new Uint8Array(await readFile(this.path(p)));return {bytes:b,hash:await digest(b),mtime:(await stat(this.path(p))).mtimeMs};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
  async put(p:string,b:Uint8Array|string){await mkdir(dirname(this.path(p)),{recursive:true});await writeFile(this.path(p),typeof b==='string'?content(b):b);}
  async replace(p:string,expected:string|null,b:Uint8Array|null,_mtime:number){if((await this.read(p))?.hash !== (expected??undefined))return false;if(b)await this.put(p,b);else await rm(this.path(p),{force:true});return true;}
  async preserve(p:string,s:Snapshot){const name=p+'.conflict-'+s.hash;await this.put(name,s.bytes);return name;}
  async text(p:string){const s=await this.read(p);return s?new TextDecoder().decode(s.bytes):undefined;}
}
async function make(name:string,remote:S3Store,state:State={base:Object.create(null)}){
  const dir=join(root,name);await mkdir(dir,{recursive:true});const local=new DiskLocal(dir);
  const engine=new SyncEngine(local,remote,state,async()=>writeFile(join(root,name+'-state.json'),JSON.stringify(state)));
  return {local,engine,state};
}
async function test(name:string,fn:()=>Promise<void>){const start=performance.now();try{await fn();records.push({name,passed:true,durationMs:Math.round(performance.now()-start)});console.log('PASS '+name);}catch(e){records.push({name,passed:false,durationMs:Math.round(performance.now()-start),error:e instanceof Error?e.message:'failed'});console.log('FAIL '+name);throw e;}}
const remote=new S3Store({...config,prefix:run+'/main'},transport);
try {
  await test('real R2 read/write and conditional-write semantics',()=>remote.check());
  const a=await make('a',remote),b=await make('b',new S3Store({...config,prefix:run+'/main'},transport));
  await test('startup downloads before uploading local pending changes',async()=>{await a.local.put('中文/笔记.md','remote initial');await a.engine.sync();await b.local.put('local.md','local pending');await b.engine.sync(true);assert.equal(await b.local.text('中文/笔记.md'),'remote initial');assert.equal((await remote.load()).manifest!.files['local.md'],undefined);await b.engine.sync();assert((await remote.load()).manifest!.files['local.md']);});
  await test('unchanged second pass publishes no new index',async()=>{await a.engine.sync();const before=(await remote.load()).etag;await a.engine.sync();assert.equal((await remote.load()).etag,before);});
  await test('binary attachment and empty files round-trip byte for byte',async()=>{const data=new Uint8Array(2*1024*1024);for(let i=0;i<data.length;i++)data[i]=i%251;await a.local.put('附件/% &图.png',data);await a.local.put('empty.md','');await a.engine.sync();await b.engine.sync();assert.equal((await b.local.read('附件/% &图.png'))!.hash,await digest(data));assert.equal(await b.local.text('empty.md'),'');});
  await test('offline changes survive failure and synchronize after reconnect',async()=>{await b.local.put('offline.md','offline content');offline=true;await assert.rejects(()=>b.engine.sync());offline=false;await b.engine.sync();await a.engine.sync();assert.equal(await a.local.text('offline.md'),'offline content');});
  await test('real concurrent same-file writes retain both versions',async()=>{await a.local.put('中文/笔记.md','edit A');await b.local.put('中文/笔记.md','edit B');await Promise.all([a.engine.sync(),b.engine.sync()]);await a.engine.sync();await b.engine.sync();const values=await Promise.all((await a.local.paths()).map(p=>a.local.text(p)));assert(values.includes('edit A'));assert(values.includes('edit B'));});
  await test('rename and remote deletion propagate',async()=>{await a.local.put('renamed.md','offline content');await rm(a.local.path('offline.md'));await a.engine.sync();await b.engine.sync();assert.equal(await b.local.text('offline.md'),undefined);assert.equal(await b.local.text('renamed.md'),'offline content');});
  await test('reload persisted baseline and pull remote edits before upload',async()=>{await a.local.put('renamed.md','changed while B closed');await a.engine.sync();const saved=JSON.parse(await readFile(join(root,'b-state.json'),'utf8'));const resumed=await make('b',remote,saved);await resumed.engine.sync(true);assert.equal(await resumed.local.text('renamed.md'),'changed while B closed');});
  await test('migrate plain Remotely Save objects without overwriting originals',async()=>{const legacy=new S3Store({...config,prefix:run+'/legacy'},transport);await legacy.request('PUT',legacy.config.prefix+'old.md',content('old raw'));const c=await make('c',legacy);await c.engine.sync(true);assert.equal(await c.local.text('old.md'),'old raw');const original=await legacy.request('GET',legacy.config.prefix+'old.md');assert.equal(new TextDecoder().decode(original.bytes),'old raw');});
  await test('list more than one thousand objects across pagination',async()=>{
    const many=new S3Store({...config,prefix:run+'/pagination'},transport);const jobs=Array.from({length:1005},(_,i)=>i);let cursor=0;
    await Promise.all(Array.from({length:8},async()=>{while(cursor<jobs.length){const i=jobs[cursor++];const r=await many.request('PUT',many.config.prefix+`file-${String(i).padStart(4,'0')}.md`,content('x'));assert.equal(r.status,200);}}));
    assert.equal((await many.list()).length,1005);
  });
} finally {
  offline=false;
  const report={timestamp:new Date().toISOString(),bucket:config.bucket,prefix:run,requests,tests:records,passed:records.length===10&&records.every(r=>r.passed),scope:'Synthetic files on this Mac; S3 adapter and sync engine. No production files and no mobile/Windows runtime.'};
  await mkdir('reports',{recursive:true});await writeFile('reports/live-r2.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:'reports/live-r2.json',passed:report.passed,tests:records.length,requests}));
}
