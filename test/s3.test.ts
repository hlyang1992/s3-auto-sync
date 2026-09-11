import { createHash,createHmac } from 'node:crypto';
import { expect,it,vi } from 'vitest';
import { S3Store } from '../src/s3.ts';
import type { Transport,Reply } from '../src/s3.ts';
import { defaults,digest } from '../src/model.ts';
import { bytes,text,client } from './helpers.ts';
const cfg={...defaults,endpoint:'https://account.r2.cloudflarestorage.com',bucket:'test-bucket',accessKeyId:'test-access',secretAccessKey:'test-secret'};
const reply=(status:number,data='',headers:Record<string,string>={}):Reply=>({status,bytes:bytes(data),headers});
const enc=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
function signatureValid(req:Parameters<Transport>[0]) {
  const h=req.headers,u=new URL(req.url),auth=h.authorization;
  const match=/Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=(.+)$/.exec(auth);
  if(!match)return false;
  const [,access,scope,signed,signature]=match;
  if(access!==cfg.accessKeyId)return false;
  const keys=signed.split(';');
  const canonHeaders=keys.map(k=>`${k}:${(k==='host'?u.host:h[k]).trim().replace(/\s+/g,' ')}\n`).join('');
  const query=[...u.searchParams].map(([k,v])=>[enc(k),enc(v)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0).map(x=>x.join('=')).join('&');
  const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
  const canonical=[req.method,u.pathname,query,canonHeaders,signed,h['x-amz-content-sha256']||hash(new Uint8Array(req.body||new ArrayBuffer(0)))].join('\n');
  const toSign=['AWS4-HMAC-SHA256',h['x-amz-date'],scope,hash(canonical)].join('\n');
  const [date,region,service]=scope.split('/');
  const hm=(key:string|Buffer,value:string)=>createHmac('sha256',key).update(value).digest();
  const key=hm(hm(hm(hm('AWS4'+cfg.secretAccessKey,date),region),service),'aws4_request');
  return hm(key,toSign).toString('hex')===signature;
}
class ObjectServer {
  objects=new Map<string,{b:Uint8Array;etag:string}>(); requests:Parameters<Transport>[0][]=[];
  ignoreCondition=false; corruptGet=false; mutateGet=false;
  transport:Transport=async req=>{
    this.requests.push(req);
    expect(signatureValid(req)).toBe(true);
    const u=new URL(req.url),key=decodeURIComponent(u.pathname.slice(('/'+cfg.bucket+'/').length));
    if(req.method==='GET'&&u.searchParams.get('list-type')==='2') {
      const prefix=u.searchParams.get('prefix')||'';
      const list=[...this.objects].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>`<Contents><Key>${enc(k)}</Key><ETag>&quot;${v.etag.slice(1,-1)}&quot;</ETag><Size>${v.b.length}</Size><LastModified>2026-09-11T01:00:00Z</LastModified></Contents>`).join('');
      return reply(200,`<ListBucketResult><IsTruncated>false</IsTruncated>${list}</ListBucketResult>`);
    }
    const old=this.objects.get(key);
    if(req.method==='GET') {
      if(!old)return reply(404);
      if(req.headers['if-none-match']===old.etag)return reply(304,'',{etag:old.etag});
      if(req.headers['if-match']&&req.headers['if-match']!==old.etag)return reply(412);
      if(this.mutateGet&& !key.startsWith('.s3-auto-sync/'))return reply(412);
      return {status:200,headers:{ETag:old.etag},bytes:this.corruptGet?bytes('corrupt'):old.b};
    }
    if(req.method==='PUT') {
      if(!this.ignoreCondition&&((req.headers['if-none-match']==='*'&&old)||(req.headers['if-match']&&req.headers['if-match']!==old?.etag)))return reply(412);
      const b=new Uint8Array(req.body||new ArrayBuffer(0)),etag='"'+createHash('md5').update(b).digest('hex')+'"';
      this.objects.set(key,{b,etag});return reply(200,'',{etag});
    }
    if(req.method==='DELETE'){this.objects.delete(key);return reply(204);}
    return reply(405);
  };
}
it('signs requests independently verified with HMAC SHA-256 and encodes Unicode and punctuation',async()=>{const server=new ObjectServer(),s=new S3Store(cfg,server.transport);await s.request('PUT','中文/% &+?.md',bytes('x'),{'if-none-match':'*'});expect(server.objects.has('中文/% &+?.md')).toBe(true);});
it('supports path-style and virtual-hosted endpoints with custom base paths',()=>{const s=new S3Store({...cfg,endpoint:'https://example.com/base',pathStyle:false},async()=>reply(200));expect(s.url('a b')).toBe('https://test-bucket.example.com/base/a%20b');});
it('verifies conditional writes and cleans connection probes',async()=>{const server=new ObjectServer(),s=new S3Store(cfg,server.transport);await s.check();expect(server.objects.size).toBe(0);});
it('rejects a provider that ignores If-Match and cleans the probe',async()=>{const server=new ObjectServer();server.ignoreCondition=true;const s=new S3Store(cfg,server.transport);await expect(s.check()).rejects.toThrow('条件写入');expect(server.objects.size).toBe(0);});
it('does not trust a successful write with bad read-back content',async()=>{const server=new ObjectServer();server.corruptGet=true;const s=new S3Store(cfg,server.transport);await expect(s.check()).rejects.toThrow('读写');expect(server.objects.size).toBe(0);});
it('imports legacy files without modifying originals, including empty and Unicode objects',async()=>{const server=new ObjectServer(),s=new S3Store(cfg,server.transport);await s.request('PUT','中文/笔记.md',bytes('legacy'));await s.request('PUT','empty.md',bytes(''));await s.request('PUT','.obsidian/data.json',bytes('private'));await s.bootstrap();const {manifest}=await s.load();expect(Object.keys(manifest!.files).sort()).toEqual(['empty.md','中文/笔记.md']);expect(text(server.objects.get('中文/笔记.md')!.b)).toBe('legacy');expect(text(await s.blob(manifest!.files['中文/笔记.md'].hash))).toBe('legacy');const n=server.requests.length;await s.bootstrap();expect(server.requests.length).toBe(n+1);});
it('legacy changing during import cannot commit a partial index',async()=>{const server=new ObjectServer(),s=new S3Store(cfg,server.transport);await s.request('PUT','note.md',bytes('x'));server.mutateGet=true;await expect(s.bootstrap()).rejects.toThrow();expect(server.objects.has('.s3-auto-sync/manifest.json')).toBe(false);});
it('real adapter and engine synchronize two clients through signed requests',async()=>{const server=new ObjectServer(),s=new S3Store(cfg,server.transport),a=client(s),b=client(new S3Store(cfg,server.transport));await a.local.set('测试.md','A');await a.engine.sync();await b.engine.sync(true);expect(b.local.get('测试.md')).toBe('A');await b.local.set('测试.md','B');await b.engine.sync();await a.engine.sync();expect(a.local.get('测试.md')).toBe('B');a.local.files.delete('测试.md');await a.engine.sync();await b.engine.sync();expect(b.local.get('测试.md')).toBeUndefined();});
it('rejects a corrupted object and a wrong upload digest',async()=>{const server=new ObjectServer(),s=new S3Store(cfg,server.transport),h=await digest(bytes('abc'));await s.putBlob(h,bytes('abc'));await s.putBlob(h,bytes('abc'));await expect(s.putBlob(h,bytes('bad'))).rejects.toThrow('校验');server.corruptGet=true;await expect(s.blob(h)).rejects.toThrow('校验');await expect(s.blob('../bad')).rejects.toThrow();});
it.each([409,412])('surfaces CAS race %i as a retry instead of success',async status=>{const s=new S3Store(cfg,async()=>reply(status));expect(await s.commit({version:1,id:'x',revision:0,files:{}},null)).toBe(false);});
it.each([401,403,429,500,503])('rejects HTTP %i with a sanitized message',async status=>{const s=new S3Store(cfg,async()=>reply(status,'secret-access-key'));await expect(s.load()).rejects.toThrow();try{await s.load();}catch(e){expect(String(e)).not.toContain('secret-access-key');}});
it('requires ETag before allowing synchronization',async()=>{const s=new S3Store(cfg,async()=>reply(200,'{}'));await expect(s.load()).rejects.toThrow('ETag');});
it('sanitizes network exceptions',async()=>{const s=new S3Store(cfg,async()=>{throw Error('authorization: sensitive');});await expect(s.load()).rejects.toThrow('网络');await expect(s.load()).rejects.not.toThrow('sensitive');});
it('supports multi-page lists with XML-escaped continuation tokens',async()=>{let page=0;const seen:string[]=[];const s=new S3Store(cfg,async req=>{seen.push(req.url);return reply(200,page++===0?'<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken></ListBucketResult>':'<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');});expect(await s.list()).toEqual([]);expect(new URL(seen[1]).searchParams.get('continuation-token')).toBe('a&b');});
it.each(['<bad/>','<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>','<!DOCTYPE x><ListBucketResult/>','<ListBucketResult><Contents><Key>x</Key><Size>bad</Size></Contents></ListBucketResult>'])('rejects malformed S3 listing %s',xml=>expect(new S3Store(cfg,async()=>reply(200,xml)).list()).rejects.toThrow());
it('rejects looping pagination',async()=>{const s=new S3Store(cfg,async()=>reply(200,'<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken></ListBucketResult>'));await expect(s.list()).rejects.toThrow('游标');});
it('never accepts out-of-prefix objects from a provider',async()=>{const xml='<ListBucketResult><Contents><Key>other</Key><ETag>x</ETag><Size>1</Size><LastModified>2026-01-01</LastModified></Contents></ListBucketResult>';const s=new S3Store({...cfg,prefix:'notes'},async()=>reply(200,xml));await expect(s.list()).rejects.toThrow('范围');});
it('does not import unsafe legacy paths',async()=>{const s=new S3Store(cfg,async req=>req.url.includes('manifest.json')?reply(404):reply(200,'<ListBucketResult><Contents><Key>..%2Fbad</Key><ETag>x</ETag><Size>1</Size><LastModified>2026-01-01</LastModified></Contents></ListBucketResult>'));await expect(s.bootstrap()).rejects.toThrow();});
it('times out a stalled provider and clears its watchdog',async()=>{vi.useFakeTimers();let started!:()=>void;const ready=new Promise<void>(r=>started=r);const s=new S3Store(cfg,()=>{started();return new Promise(()=>{});},100);const promise=s.load();const rejected=expect(promise).rejects.toThrow('超时');await ready;await vi.advanceTimersByTimeAsync(100);await rejected;expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();});
it.each(['putBlob','blob','commit','check','list'])('fails closed when %s receives HTTP 503',async op=>{const s=new S3Store(cfg,async()=>reply(503));if(op==='putBlob')await expect(s.putBlob(await digest(bytes('x')),bytes('x'))).rejects.toThrow();if(op==='blob')await expect(s.blob('a'.repeat(64))).rejects.toThrow();if(op==='commit')await expect(s.commit({version:1,id:'x',revision:0,files:{}},'"old"')).rejects.toThrow();if(op==='check')await expect(s.check()).rejects.toThrow();if(op==='list')await expect(s.list()).rejects.toThrow();});
it('refuses legacy import when downloaded size differs from the listing',async()=>{const server=new ObjectServer(),s=new S3Store(cfg,server.transport);await s.request('PUT','x.md',bytes('x'));const request=s.request.bind(s);vi.spyOn(s,'request').mockImplementation(async(...args)=>{const r=await request(...args);if(args[0]==='GET'&&args[1]==='x.md')r.bytes=bytes('longer');return r;});await expect(s.bootstrap()).rejects.toThrow('大小');});
it('reports connection-probe cleanup failures',async()=>{const server=new ObjectServer(),s=new S3Store(cfg,async req=>req.method==='DELETE'?reply(403):server.transport(req));await expect(s.check()).rejects.toThrow('被拒绝');});
it('keeps compression and cache controls unsigned but signs concurrency headers',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,server.transport);
 await s.request('GET','manifest',undefined,{'if-match':'"version"'});
 const req=server.requests[0];expect(req.headers['accept-encoding']).toBe('identity');expect(req.headers['cache-control']).toBe('no-cache');
 const signed=/SignedHeaders=([^,]+)/.exec(req.headers.authorization)![1];expect(signed).toContain('if-match');expect(signed).not.toContain('accept-encoding');expect(signed).not.toContain('cache-control');
});
it('bypasses stale HTTP caches on every mutable read including cached 404s',async()=>{
 const server=new ObjectServer(),cache=new Map<string,Reply>();
 const s=new S3Store(cfg,async req=>{if(req.method!=='GET')return server.transport(req);if(!cache.has(req.url))cache.set(req.url,await server.transport(req));return structuredClone(cache.get(req.url)!);});
 expect((await s.load()).manifest).toBeNull();await s.commit({version:1,id:'test',revision:0,files:{}},null);
 const old=await s.load();await s.commit({...old.manifest!,revision:1},old.etag);expect((await s.load()).manifest!.revision).toBe(1);expect(cache.size).toBe(3);
});
it('recovers a strong ETag from the complete range after proxy compression and commits safely',async()=>{
 const server=new ObjectServer();let fallback=0;
 const s=new S3Store(cfg,async req=>{const r=await server.transport(req);if(req.method==='GET'&&r.status===200&&!new URL(req.url).searchParams.has('list-type')){
  if(req.headers.range){fallback++;return {...r,status:206,headers:{...r.headers,'content-range':`bytes 0-${r.bytes.length-1}/${r.bytes.length}`}};}
  return {...r,headers:{ETag:'W/'+r.headers.ETag,'content-encoding':'gzip'}};
 }return r;});
 await s.commit({version:1,id:'test',revision:0,files:{}},null);const before=await s.load();expect(before.etag).not.toMatch(/^W\//);
 expect(await s.commit({...before.manifest!,revision:1},before.etag)).toBe(true);expect((await s.load()).manifest!.revision).toBe(1);expect(fallback).toBe(2);
 await s.check();expect([...server.objects.keys()]).toEqual(['.s3-auto-sync/manifest.json']);
});
it.each(['bytes 1-9/10','bytes 0-4/10','bytes 0-9/20','garbage',''])('rejects incomplete fallback range %s',async range=>{
 const s=new S3Store(cfg,async req=>req.headers.range?reply(206,'0123456789',{etag:'"strong"','content-range':range}):reply(200,'0123456789',{etag:'W/"weak"'}));
 await expect(s.load()).rejects.toThrow('完整');
});
it('rejects providers that still return a weak ETag and never strips the weakness marker',async()=>{
 const s=new S3Store(cfg,async()=>reply(200,'{}',{etag:'W/"weak"'}));await expect(s.load()).rejects.toThrow('强 ETag');
 await expect(s.commit({version:1,id:'test',revision:0,files:{}},'W/"weak"')).rejects.toThrow('ETag');
});
it('allows a complete 200 range fallback but propagates an HTTP failure',async()=>{
 let status=200;const manifest={version:1,id:'test',revision:0,files:{}};
 const s=new S3Store(cfg,async req=>req.headers.range?reply(status,JSON.stringify(manifest),{etag:'"strong"'}):reply(200,'{}',{etag:'W/"weak"'}));
 expect((await s.load()).etag).toBe('"strong"');status=503;await expect(s.load()).rejects.toThrow('503');
});
it('checks both successful and rejected conditional writes, reports phases and leaves notes untouched',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,server.transport);await s.request('PUT','note.md',bytes('original'));
 const stages:string[]=[];await s.check(s=>stages.push(s));expect(stages).toHaveLength(6);expect(stages[0]).toContain('1/6');expect(stages[5]).toContain('6/6');
 expect([...server.objects.keys()]).toEqual(['note.md']);expect(text(server.objects.get('note.md')!.b)).toBe('original');
 const puts=server.requests.filter(r=>r.method==='PUT'&&r.url.includes('/probes/'));expect(puts).toHaveLength(4);
 expect(puts.filter(r=>r.headers['if-match']&&!r.headers['if-match'].includes('wrong'))).toHaveLength(1);
 expect(server.requests.some(r=>r.url.includes('manifest.json')||r.url.includes('/blobs/'))).toBe(false);
});
it('only lists one object and one page during connection checking',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,async req=>new URL(req.url).searchParams.has('list-type')?reply(200,'<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>'):server.transport(req));
 const spy=vi.spyOn(s,'request');await s.check();const lists=spy.mock.calls.filter(c=>c[4]?.['list-type']==='2');expect(lists).toHaveLength(1);expect(lists[0][4]!['max-keys']).toBe('1');
});
it('rejects false-positive connection checks when a correct ETag cannot update',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,async req=>req.method==='PUT'&&req.headers['if-match']?reply(412):server.transport(req));
 await expect(s.check()).rejects.toThrow('正常更新');expect(server.objects.size).toBe(0);
});
it('rejects a provider that ignores create-only conditions and cleans its probe',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,async req=>{if(req.method==='PUT'&&req.headers['if-none-match']==='*'&&server.objects.size)return reply(200);return server.transport(req);});
 await expect(s.check()).rejects.toThrow('条件写入');expect(server.objects.size).toBe(0);
});
it('reports both primary and cleanup failures without leaking service response bodies',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,async req=>req.method==='DELETE'?reply(403,'secret'):req.method==='GET'&&req.url.includes('/probes/')?reply(500,'secret'):server.transport(req));
 await expect(s.check()).rejects.toThrow(/读写.*清理/);await expect(s.check()).rejects.not.toThrow('secret');
});
it('reports failed probe creation without claiming a successful connection',async()=>{
 const s=new S3Store(cfg,async req=>req.method==='PUT'?reply(403):reply(200,'<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'));
 await expect(s.check()).rejects.toThrow(/写入.*403/);
});
it('uses a fifteen-second request timeout for checks while keeping long file transfers supported',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,server.transport);const spy=vi.spyOn(s,'request');await s.check();expect(spy.mock.calls.every(c=>c[5]===15_000)).toBe(true);
});
it('reports per-file initialization progress and final index submission',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,server.transport),progress:string[]=[];await s.request('PUT','a.md',bytes('A'));await s.request('PUT','b.md',bytes('B'));
 await s.bootstrap(s=>progress.push(s));expect(progress).toEqual(expect.arrayContaining([expect.stringContaining('1/2'),expect.stringContaining('2/2'),expect.stringContaining('提交 2')]));
});
it('includes signing in the timeout and never sends a request after its deadline',async()=>{
 vi.useFakeTimers();const transport=vi.fn(async()=>reply(200));const s=new S3Store(cfg,transport,100);let resume!:(r:Request)=>void;
 vi.spyOn((s as any).signer,'sign').mockImplementation(()=>new Promise<Request>(yes=>resume=yes));
 const pending=s.load(),failed=expect(pending).rejects.toThrow('超时');await vi.advanceTimersByTimeAsync(100);await failed;
 resume(new Request('https://example.com'));await Promise.resolve();await Promise.resolve();expect(transport).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
});
it('rejects an oversized remote index before parsing its contents',async()=>{
 const s=new S3Store(cfg,async()=>({status:200,headers:{etag:'"large"'},bytes:new Uint8Array(32*1024*1024+1)}));await expect(s.load()).rejects.toThrow('32 MB');
});
it('uses only supported ListObjectsV2 parameters on strict R2 endpoints',async()=>{
 const server=new ObjectServer(),allowed=new Set(['list-type','encoding-type','prefix','max-keys','continuation-token']);let lists=0;
 const s=new S3Store(cfg,async req=>{const u=new URL(req.url);if(u.searchParams.has('list-type')){lists++;for(const key of u.searchParams.keys())if(!allowed.has(key))return reply(501,'<Error><Code>NotImplemented</Code></Error>');expect(req.headers['cache-control']).toBe('no-cache');}return server.transport(req);});
 await s.check();await s.list();expect(lists).toBe(2);
});
it('conditionally checks a warm index and downloads no body for an unchanged remote',async()=>{
 const server=new ObjectServer(),s=new S3Store(cfg,server.transport),m={version:1 as const,id:'test',revision:0,files:{}};await s.commit(m,null);
 const first=await s.load(),read=server.requests.at(-1)!;expect(read.headers['if-none-match']).toBeUndefined();
 const request=vi.spyOn(s,'request'),second=await s.load();expect(second).toEqual(first);expect(request.mock.calls[0][3]!['if-none-match']).toBe(first.etag);
 expect((await request.mock.results[0].value).bytes.length).toBe(0);expect((await request.mock.results[0].value).status).toBe(304);
 first.manifest!.revision=999;second.manifest!.revision=999;expect((await s.load()).manifest!.revision).toBe(0);
});
it('refetches changes committed by another client, including deletion of the index',async()=>{
 const server=new ObjectServer(),a=new S3Store(cfg,server.transport),b=new S3Store(cfg,server.transport);await a.commit({version:1,id:'test',revision:0,files:{}},null);
 const initial=await a.load();await b.commit({...initial.manifest!,revision:1},initial.etag);expect((await a.load()).manifest!.revision).toBe(1);
 server.objects.delete('.s3-auto-sync/manifest.json');expect((await a.load()).manifest).toBeNull();await a.load();expect(server.requests.at(-1)!.headers['if-none-match']).toBeUndefined();
});
it('rejects an unsolicited 304 without inventing an index',async()=>{
 await expect(new S3Store(cfg,async()=>reply(304)).load()).rejects.toThrow('没有本地索引缓存');
});
it('does not mask a server error with its cached successful index',async()=>{
 const server=new ObjectServer();let denied=false;const s=new S3Store(cfg,async req=>denied?reply(403):server.transport(req));await s.commit({version:1,id:'test',revision:0,files:{}},null);await s.load();denied=true;await expect(s.load()).rejects.toThrow('403');
});
