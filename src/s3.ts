import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';
import { INTERNAL, digest, parseManifest, syncPath, validateConfig } from './model.ts';
import type { Config, Manifest, RemoteFiles } from './model.ts';

export interface Reply { status: number; headers: Record<string, string>; bytes: Uint8Array }
export type Transport = (req: { url: string; method: string; headers: Record<string,string>; body?: ArrayBuffer }) => Promise<Reply>;
interface ListedObject { Key: string; ETag: string; Size: string; LastModified: string }
interface ListResponse { ListBucketResult?: { Contents?: ListedObject | ListedObject[]; IsTruncated?: string; NextContinuationToken?: string } }
export class S3Error extends Error {
  constructor(public status: number, public operation: string) {
    super(status === 403 ? `S3 ${operation}被拒绝（HTTP 403），请检查密钥及目标桶权限。` : status === 401 ? 'S3 认证失败（HTTP 401）。' : `S3 ${operation}失败（HTTP ${status}）。`);
  }
}
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export class S3Store implements RemoteFiles {
  readonly config: Config;
  private signer: AwsClient;
  private indexCache?: {manifest: Manifest; etag: string};
  constructor(config: Config, private transport: Transport, private timeoutMs = 60_000) {
    this.config = validateConfig(config);
    this.signer = new AwsClient({accessKeyId:this.config.accessKeyId,secretAccessKey:this.config.secretAccessKey,region:this.config.region,service:'s3',retries:0});
  }
  url(key = '', query?: Record<string,string>): string {
    const c = this.config, u = new URL(c.endpoint);
    if (c.pathStyle) u.pathname = u.pathname.replace(/\/$/, '') + '/' + encode(c.bucket);
    else u.hostname = c.bucket + '.' + u.hostname;
    u.pathname = u.pathname.replace(/\/$/, '') + '/' + key.split('/').map(encode).join('/');
    for (const [k,v] of Object.entries(query || {})) u.searchParams.set(k,v);
    return u.href;
  }
  async request(method: string, key: string, body?: Uint8Array, headers: Record<string,string> = {}, query?: Record<string,string>, timeoutMs = this.timeoutMs): Promise<Reply> {
    let reply: Reply;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const timeoutError = new Error(`S3 请求超时（${timeoutMs / 1000} 秒），请检查网络后重试。`);
    try {
      reply = await Promise.race([
        (async () => {
          const reading = method === 'GET' || method === 'HEAD';
          // R2 rejects unknown ListObjectsV2 parameters. Only object reads get
          // a unique URL; bucket listings use the no-cache header below.
          const request = await this.signer.sign(this.url(key, reading && key !== '' ? {...query,'s3-sync-request':crypto.randomUUID()} : query), {method,headers,body:body?.slice().buffer,aws:{allHeaders:true}});
          if (expired) throw timeoutError;
          // Proxies may rewrite these headers. Keep them outside SigV4, while
          // signing If-Match and all other concurrency/security headers.
          return this.transport({url:request.url,method,headers:{...Object.fromEntries(request.headers),...(reading ? {'accept-encoding':'identity','cache-control':'no-cache'} : {})},body:body?.slice().buffer});
        })(),
        new Promise<never>((_,reject) => { timeout = setTimeout(() => { expired = true; reject(timeoutError); },timeoutMs); })
      ]);
    } catch (e) { if (e === timeoutError) throw timeoutError; throw new Error('S3 网络请求失败，请检查 Endpoint 和网络连接后重试。'); }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
    reply.headers = Object.fromEntries(Object.entries(reply.headers).map(([k,v]) => [k.toLowerCase(),v]));
    return reply;
  }
  private key(s: string) { return this.config.prefix + INTERNAL + s; }
  private async readForUpdate(key: string, timeoutMs = this.timeoutMs, headers: Record<string,string> = {}): Promise<Reply> {
    let r = await this.request('GET',key,undefined,headers,undefined,timeoutMs);
    // Compression can turn a strong origin ETag into W/"...". Never strip W/:
    // obtain the complete uncompressed representation before using If-Match.
    if (r.status === 200 && r.headers.etag?.startsWith('W/')) {
      r = await this.request('GET',key,undefined,{range:'bytes=0-'},undefined,timeoutMs);
      if (r.status === 206) {
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(r.headers['content-range'] || '');
        if (!range || Number(range[1]) + 1 !== r.bytes.length || Number(range[2]) !== r.bytes.length) throw new Error('S3 未返回完整索引内容，已停止同步。');
        r.status = 200;
      }
    }
    if (r.status === 200 && !/^"[^"\r\n]+"$/.test(r.headers.etag || '')) throw new Error('S3 未返回强 ETag，无法安全更新索引；请检查服务端压缩设置。');
    return r;
  }
  async load(): Promise<{manifest: Manifest | null; etag: string | null}> {
    const cached = this.indexCache;
    const r = await this.readForUpdate(this.key('manifest.json'),this.timeoutMs,cached ? {'if-none-match':cached.etag} : {});
    if (r.status === 304) {
      if (!cached) throw new Error('S3 返回未变化状态，但没有本地索引缓存。');
      return structuredClone(cached);
    }
    if (r.status === 404) { this.indexCache = undefined; return {manifest:null,etag:null}; }
    if (r.status !== 200) throw new S3Error(r.status,'读取索引');
    if (r.bytes.byteLength > 32 * 1024 * 1024) throw new Error('同步索引超过 32 MB，已停止读取。');
    const result = {manifest:parseManifest(decoder.decode(r.bytes)),etag:r.headers.etag};
    this.indexCache = structuredClone(result);
    return result;
  }
  async commit(manifest: Manifest, etag: string | null): Promise<boolean> {
    if (etag !== null && !/^"[^"\r\n]+"$/.test(etag)) throw new Error('S3 索引 ETag 无效，已停止提交。');
    const body = JSON.stringify(manifest);
    parseManifest(body);
    const r = await this.request('PUT',this.key('manifest.json'),encoder.encode(body),{'content-type':'application/json',...(etag ? {'if-match':etag} : {'if-none-match':'*'})});
    this.indexCache = undefined;
    if (r.status === 412 || r.status === 409) return false;
    if (r.status !== 200) throw new S3Error(r.status,'更新索引');
    return true;
  }
  async blob(hash: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('文件摘要无效。');
    const r = await this.request('GET',this.key('blobs/' + hash));
    if (r.status !== 200) throw new S3Error(r.status,'下载文件');
    if (await digest(r.bytes) !== hash) throw new Error('下载内容校验失败，未覆盖本地文件。');
    return r.bytes;
  }
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    if (await digest(bytes) !== hash) throw new Error('上传内容校验失败。');
    const r = await this.request('PUT',this.key('blobs/' + hash),bytes,{'content-type':'application/octet-stream','if-none-match':'*'});
    if (r.status !== 200 && r.status !== 412) throw new S3Error(r.status,'上传文件');
  }
  async list(firstPageOnly = false, timeoutMs = this.timeoutMs): Promise<{key: string; etag: string; size: number; mtime: number}[]> {
    const parser = new XMLParser({parseTagValue:false,ignoreAttributes:true});
    const results = []; let token = ''; const seen = new Set<string>();
    do {
      const r = await this.request('GET','',undefined,{}, {'list-type':'2','encoding-type':'url','prefix':this.config.prefix,...(firstPageOnly ? {'max-keys':'1'} : {}),...(token ? {'continuation-token':token} : {})},timeoutMs);
      if (r.status !== 200) throw new S3Error(r.status,'列出文件');
      const xml = decoder.decode(r.bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('S3 文件列表包含不允许的 XML 声明。');
      const doc = (parser.parse(xml) as ListResponse).ListBucketResult;
      if (!doc) throw new Error('S3 文件列表格式无效。');
      const entries = doc.Contents ? (Array.isArray(doc.Contents) ? doc.Contents : [doc.Contents]) : [];
      for (const e of entries) {
        const key = decodeURIComponent(e.Key);
        if (!key.startsWith(this.config.prefix)) throw new Error('S3 返回了目录范围之外的文件。');
        // ETag contains XML quote entities, while keys are percent encoded by S3.
        const etag = String(e.ETag || '').replace(/&quot;/g,'"');
        const size = Number(e.Size), mtime = Date.parse(e.LastModified);
        if (!etag || !Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtime)) throw new Error('S3 文件属性无效。');
        results.push({key,etag,size,mtime});
      }
      if (firstPageOnly) return results;
      token = doc.IsTruncated === 'true' ? doc.NextContinuationToken || '' : '';
      if (doc.IsTruncated === 'true' && (!token || seen.has(token))) throw new Error('S3 分页游标无效。');
      if (token) seen.add(token);
    } while (token);
    return results;
  }
  async bootstrap(progress: (text: string) => void = () => {}): Promise<void> {
    if ((await this.load()).manifest) return;
    const m: Manifest = {version:1,id:crypto.randomUUID(),revision:0,files:Object.create(null) as Manifest['files']};
    progress('正在初始化远端 · 列出已有文件');
    const objects = (await this.list()).filter(object => {
      const path = object.key.slice(this.config.prefix.length);
      return !path.endsWith('/') && !path.split('/').some(s => s.startsWith('.'));
    });
    for (const [index,object] of objects.entries()) {
      const path = object.key.slice(this.config.prefix.length);
      progress(`正在初始化远端 · ${index + 1}/${objects.length} · ${path}`);
      if (!syncPath(path)) throw new Error('原远端存在不兼容的文件名，请先调整后再接入。');
      const r = await this.request('GET',object.key,undefined,{'if-match':object.etag});
      if (r.status !== 200) throw new S3Error(r.status,'导入原文件');
      if (r.bytes.length !== object.size) throw new Error('原远端文件大小发生变化，稍后重试。');
      const hash = await digest(r.bytes);
      await this.putBlob(hash,r.bytes);
      m.files[path] = {hash,size:r.bytes.length,mtime:object.mtime};
    }
    // Never overwrite another device's initial manifest; load its result next.
    progress(`正在初始化远端 · 提交 ${objects.length} 个文件的索引`);
    await this.commit(m,null);
  }
  async check(progress: (text: string) => void = () => {}): Promise<void> {
    const timeoutMs = Math.min(this.timeoutMs,15_000);
    const key = this.key('probes/' + crypto.randomUUID());
    // Exercise the same compressible content type as the real manifest.
    const bytes = encoder.encode(JSON.stringify({check:'S3 Auto Sync connection check'.repeat(80)}));
    let step = '检查列举权限', primary: Error | undefined;
    const stage = (n: number, text: string) => { step = text; progress(`检查连接 ${n}/6 · ${text}`); };
    const request = (method: string, body?: Uint8Array, headers?: Record<string,string>) => this.request(method,key,body,headers,undefined,timeoutMs);
    stage(1,'检查列举权限');
    await this.list(true,timeoutMs);
    stage(2,'检查写入权限');
    const r = await request('PUT',bytes,{'content-type':'application/json','if-none-match':'*'});
    if (r.status !== 200) throw new S3Error(r.status,step);
    try {
      stage(3,'检查读取和内容校验');
      const get = await this.readForUpdate(key,timeoutMs);
      if (get.status !== 200 || decoder.decode(get.bytes) !== decoder.decode(bytes)) throw new Error('S3 读写检查失败。');
      stage(4,'检查正常更新');
      const update = await request('PUT',bytes,{'if-match':get.headers.etag,'content-type':'application/json'});
      if (update.status !== 200) throw new Error(`S3 条件写入检查失败（HTTP ${update.status}），当前配置无法安全同步。`);
      stage(5,'检查冲突保护');
      const race = await request('PUT',bytes,{'if-match':'"intentionally-wrong-etag"'});
      const duplicate = await request('PUT',bytes,{'if-none-match':'*'});
      if (race.status !== 412 || duplicate.status !== 412) throw new Error('此 S3 服务未正确支持条件写入，无法保证同步安全。');
    } catch (e) {
      primary = new Error(`${step}失败：${e instanceof Error ? e.message : '未知错误'}`);
    }
    stage(6,'清理检查文件');
    try {
      const del = await request('DELETE');
      if (del.status !== 204 && del.status !== 200) throw new S3Error(del.status,step);
    } catch (e) {
      throw new Error(`${primary ? primary.message + '；' : ''}清理检查文件失败：${e instanceof Error ? e.message : '未知错误'}`);
    }
    if (primary) throw primary;
  }
}
