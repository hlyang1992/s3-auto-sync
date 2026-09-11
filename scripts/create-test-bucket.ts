import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fromRemotelySave } from './legacy-config.ts';
import { S3Store } from '../src/s3.ts';
const sourcePath = process.env.REMOTELY_SAVE_CONFIG;
if (!sourcePath) throw new Error('Set REMOTELY_SAVE_CONFIG to the existing local plugin data.json path.');
const source = fromRemotelySave(JSON.parse(await readFile(sourcePath,'utf8')));
const bucket = 's3-auto-sync-test-' + new Date().toISOString().slice(0,10).replaceAll('-','') + '-' + crypto.randomUUID().slice(0,8);
const store = new S3Store({...source,bucket,prefix:'',pathStyle:true},async req => {
  const r = await fetch(req.url,{method:req.method,headers:req.headers,body:req.body,signal:AbortSignal.timeout(30_000)});
  return {status:r.status,headers:Object.fromEntries(r.headers),bytes:new Uint8Array(await r.arrayBuffer())};
});
const result = await store.request('PUT','');
console.log(JSON.stringify({action:'create-test-bucket',bucket,status:result.status}));
if(result.status !== 200) process.exitCode=1;
else {
  await mkdir('.private',{recursive:true,mode:0o700});
  await writeFile('.private/target.json',JSON.stringify({bucket,sourcePath},null,2),{mode:0o600});
  await store.check();
  console.log('Test bucket read/write/conditional-write check passed.');
}
