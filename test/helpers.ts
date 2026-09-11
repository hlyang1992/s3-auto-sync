import { digest, parseManifest } from '../src/model.ts';
import type { LocalFiles, Manifest, RemoteFiles, Snapshot, State } from '../src/model.ts';
import { SyncEngine } from '../src/engine.ts';
export const bytes = (s: string) => new TextEncoder().encode(s);
export const text = (s: Uint8Array) => new TextDecoder().decode(s);
export class MemoryLocal implements LocalFiles {
  files = new Map<string,Snapshot>(); preserved: string[] = []; beforeReplace?: () => Promise<void>;
  async set(path: string, data: string | Uint8Array) { const b = typeof data === 'string' ? bytes(data) : data; this.files.set(path,{bytes:b,hash:await digest(b),mtime:Date.now()}); }
  async paths() { return [...this.files.keys()]; }
  async read(path: string) { return this.files.get(path) ?? null; }
  async replace(path: string, expected: string | null, b: Uint8Array | null, mtime: number) {
    if (this.beforeReplace) { const fn = this.beforeReplace; this.beforeReplace = undefined; await fn(); }
    if ((this.files.get(path)?.hash ?? null) !== expected) return false;
    if (b) this.files.set(path,{bytes:b,mtime,hash:await digest(b)}); else this.files.delete(path);
    return true;
  }
  async preserve(path: string, s: Snapshot) { const p = path + '.conflict-' + s.hash; this.files.set(p,structuredClone(s)); this.preserved.push(p); return p; }
  get(path: string) { const s = this.files.get(path); return s ? text(s.bytes) : undefined; }
}
export class MemoryRemote implements RemoteFiles {
  manifest: Manifest | null = null; etag = 0; blobs = new Map<string,Uint8Array>(); commits = 0; uploads = 0;
  beforeCommit?: () => Promise<void>; failUpload = false; failLoad = false; rejectCommits = false; afterCommit?: () => never;
  async load() { if (this.failLoad) throw new Error('offline'); return {manifest:structuredClone(this.manifest),etag:this.manifest ? String(this.etag) : null}; }
  async bootstrap() { if (!this.manifest) { this.manifest = {version:1,id:'test-vault',revision:0,files:{}}; this.etag++; } }
  async blob(hash: string) { const b = this.blobs.get(hash); if (!b) throw new Error('missing blob'); return b; }
  async putBlob(hash: string,b: Uint8Array) { if (this.failUpload) throw new Error('offline upload'); this.uploads++; this.blobs.set(hash,b); }
  async commit(m: Manifest,etag: string | null) {
    if (this.beforeCommit) { const fn = this.beforeCommit; this.beforeCommit = undefined; await fn(); }
    if (this.rejectCommits || (this.manifest ? String(this.etag) : null) !== etag) return false;
    this.manifest = parseManifest(JSON.stringify(m)); this.etag++; this.commits++; this.afterCommit?.(); return true;
  }
}
export function client(remote: RemoteFiles,local = new MemoryLocal(),state: State = {base:Object.create(null)},save = async () => {}) {
  return {local,state,engine:new SyncEngine(local,remote,state,save)};
}
export async function seed(remote: MemoryRemote,files: Record<string,string> = {'note.md':'original'}) {
  const c = client(remote); for (const [p,t] of Object.entries(files)) await c.local.set(p,t); await c.engine.sync(); return c;
}
