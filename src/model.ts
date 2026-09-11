export const INTERNAL = '.s3-auto-sync/';
export interface Config { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string; prefix: string; pathStyle: boolean }
export const defaults: Config = { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', region: '', prefix: '', pathStyle: true };
export interface Entry { hash: string; size: number; mtime: number; deleted?: boolean }
export interface Manifest { version: 1; id: string; revision: number; files: Record<string, Entry> }
export interface State { remoteId?: string; revision?: number; base: Record<string, string | null> }
export interface Snapshot { bytes: Uint8Array; mtime: number; hash: string }
export interface LocalFiles {
  paths(): Promise<string[]>;
  read(path: string): Promise<Snapshot | null>;
  /** Session-only hint. Undefined forces a fresh read; never used before writes. */
  cachedHash?(path: string): string | undefined;
  /** Compare again after all network waits. False means a local edit won the race. */
  replace(path: string, expected: string | null, bytes: Uint8Array | null, mtime: number): Promise<boolean>;
  preserve(path: string, snapshot: Snapshot): Promise<string>;
}
export interface RemoteFiles {
  load(): Promise<{ manifest: Manifest | null; etag: string | null }>;
  bootstrap(progress?: (text: string) => void): Promise<void>;
  blob(hash: string): Promise<Uint8Array>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  commit(manifest: Manifest, etag: string | null): Promise<boolean>;
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))).map(b => b.toString(16).padStart(2, '0')).join('');
}
export const own = (o: object, key: string) => Object.hasOwn(o, key);
export function validPath(path: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject control characters in remote filenames before touching the vault.
  return !!path && path === path.normalize('NFC') && !/[\\\x00-\x1f\x7f:<>"|?*]/.test(path) &&
    path.split('/').every(p => !!p && p !== '.' && p !== '..' && !/[. ]$/.test(p) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
export function syncPath(path: string): boolean {
  return validPath(path) && path.split('/').every(p => !p.startsWith('.'));
}
export function validateConfig(config: Config): Config {
  const c = { ...config, endpoint: config.endpoint.trim().replace(/\/+$/, ''), bucket: config.bucket.trim(), prefix: config.prefix.trim().replace(/^\/+|\/+$/g, ''), accessKeyId: config.accessKeyId.trim(), secretAccessKey: config.secretAccessKey.trim() };
  let url: URL;
  try { url = new URL(c.endpoint); } catch { throw new Error('请输入有效的 S3 Endpoint。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Endpoint 必须是 HTTPS 地址，且不能含账号、查询参数或片段。');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket)) throw new Error('请输入有效的 Bucket 名称。');
  if (!c.accessKeyId || !c.secretAccessKey) throw new Error('请填写 Access Key 和 Secret Key。');
  if (c.prefix && (!validPath(c.prefix) || c.prefix.startsWith(INTERNAL))) throw new Error('远端目录无效。');
  c.prefix = c.prefix ? c.prefix + '/' : '';
  c.region = c.region.trim() || (url.hostname.endsWith('.r2.cloudflarestorage.com') ? 'auto' : 'us-east-1');
  return c;
}
export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Manifest;
  if (!m || m.version !== 1 || typeof m.id !== 'string' || !m.id || !Number.isSafeInteger(m.revision) || m.revision < 0 || !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('远端同步索引格式无效，已停止同步。');
  const names = new Set<string>();
  for (const [path, e] of Object.entries(m.files)) {
    if (!syncPath(path) || !e || !/^[0-9a-f]{64}$/.test(e.hash) || !Number.isSafeInteger(e.size) || e.size < 0 || !Number.isFinite(e.mtime) || e.mtime < 0 || (e.deleted !== undefined && typeof e.deleted !== 'boolean')) throw new Error('远端同步索引含无效路径或文件信息，已停止同步。');
    if (!e.deleted) {
      const lower = path.toLowerCase();
      if (names.has(lower)) throw new Error('远端存在仅大小写不同的文件名，需先处理。');
      names.add(lower);
    }
  }
  for (const path of names) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { if (names.has(parts.join('/'))) throw new Error('远端文件与文件夹路径冲突。'); parts.pop(); }
  }
  return m;
}
