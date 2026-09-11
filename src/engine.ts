import { digest, own, parseManifest } from './model.ts';
import type { Entry, LocalFiles, Manifest, RemoteFiles, Snapshot, State } from './model.ts';

export interface SyncResult { uploaded: number; downloaded: number; deleted: number; conflicts: number }
export class SyncEngine {
  stopped = false;
  constructor(private local: LocalFiles, private remote: RemoteFiles, readonly state: State, private save: () => Promise<void>, private progress: (text: string) => void = () => {}) {}
  stop() { this.stopped = true; }
  private check() { if (this.stopped) throw new Error('同步已暂停。'); }
  async sync(pullOnly = false): Promise<SyncResult> {
    const result = {uploaded:0,downloaded:0,deleted:0,conflicts:0};
    for (let attempt = 0; attempt < 5; attempt++) {
      this.check();
      this.progress('正在读取远端索引');
      let {manifest,etag} = await this.remote.load();
      if (!manifest) {
        if (this.state.remoteId) throw new Error('远端索引消失，已暂停以保护本地文件。');
        this.progress('正在初始化远端');
        await this.remote.bootstrap(this.progress);
        ({manifest,etag} = await this.remote.load());
        if (!manifest) throw new Error('远端初始化失败。');
      }
      parseManifest(JSON.stringify(manifest));
      if (this.state.remoteId && this.state.remoteId !== manifest.id) throw new Error('远端笔记库身份发生变化，已停止同步。');
      if ((this.state.revision ?? 0) > manifest.revision) throw new Error('远端索引版本倒退，已停止同步。');
      for (const path of Object.keys(this.state.base)) {
        if (!own(manifest.files,path)) throw new Error('远端索引缺少已有文件记录，已停止同步。');
      }
      this.state.remoteId = manifest.id;
      this.state.revision = manifest.revision;
      const proposals = Object.create(null) as Record<string, Entry>;
      const proposalBase = Object.create(null) as Record<string,string|null>;
      const paths = new Set([...await this.local.paths(),...Object.keys(manifest.files),...Object.keys(this.state.base)]);
      // Active files first; folder renames arrive before old paths are removed.
      const sorted = [...paths].sort((a,b) => Number(!!manifest.files[a]?.deleted) - Number(!!manifest.files[b]?.deleted) || a.localeCompare(b));
      for (const [index,path] of sorted.entries()) {
        this.check();
        this.progress(`正在核对文件 · ${index + 1}/${sorted.length} · ${path}`);
        const entry = own(manifest.files,path) ? manifest.files[path] : undefined;
        const remoteHash = entry && !entry.deleted ? entry.hash : null;
        const cached = this.local.cachedHash?.(path);
        if (cached !== undefined && cached === remoteHash) { this.state.base[path] = cached; continue; }
        const snapshot = await this.local.read(path), localHash = snapshot?.hash ?? null;
        const known = own(this.state.base,path), base = known ? this.state.base[path] : undefined;
        if (localHash === remoteHash) { if (entry || known) this.state.base[path] = localHash; continue; }
        const remoteChanged = known ? remoteHash !== base : !!entry;
        if (remoteChanged) {
          // Preserve edits before applying remote content, including first contact.
          if (snapshot && localHash !== base) {
            const conflictPath = await this.local.preserve(path,snapshot);
            result.conflicts++;
            this.progress('已保留冲突副本');
            if (!pullOnly) {
              await this.stage(conflictPath,snapshot,proposals,proposalBase);
            }
          }
          this.progress(`${remoteHash ? '正在下载' : '正在应用删除'} · ${index + 1}/${sorted.length} · ${path}`);
          const bytes = remoteHash ? await this.remote.blob(remoteHash) : null;
          if (bytes && (await digest(bytes) !== remoteHash || bytes.length !== entry!.size)) throw new Error('远端文件校验失败。');
          this.check();
          if (await this.local.replace(path,localHash,bytes,entry?.mtime ?? Date.now())) {
            this.state.base[path] = remoteHash;
            if (bytes) result.downloaded++; else result.deleted++;
          }
        } else if (!pullOnly) {
          if (snapshot) await this.stage(path,snapshot,proposals,proposalBase);
          else if (entry && known) {
            proposals[path] = {...entry,deleted:true,mtime:Date.now()};
            proposalBase[path] = null;
          }
        }
      }
      await this.save();
      if (!Object.keys(proposals).length) return result;
      const deletes = Object.values(proposals).filter(e => e.deleted).length;
      const active = Object.values(manifest.files).filter(e => !e.deleted).length;
      if (deletes >= 10 && deletes >= active / 4) throw new Error('检测到大量本地文件消失，已暂停上传删除。可用“重新拉取远端”恢复文件。');
      const next: Manifest = {...manifest,revision:manifest.revision + 1,files:{...manifest.files,...proposals}};
      parseManifest(JSON.stringify(next));
      this.check();
      this.progress(`正在提交同步结果 · ${Object.keys(proposals).length} 个文件`);
      if (await this.remote.commit(next,etag)) {
        Object.assign(this.state.base,proposalBase);
        this.state.revision = next.revision;
        await this.save();
        result.uploaded += Object.values(proposals).filter(e => !e.deleted).length;
        result.deleted += deletes;
        return result;
      }
      // A concurrent writer won. Re-read and three-way reconcile before retrying.
      this.progress(`正在重新核对远端变化 · ${attempt + 1}/5`);
    }
    throw new Error('远端索引连续 5 次提交冲突，本轮同步已停止。请检查是否有其他设备同步后重试。');
  }
  private async stage(path: string, s: Snapshot, proposals: Record<string,Entry>, bases: Record<string,string|null>) {
    this.check();
    this.progress(`正在上传 · ${path}`);
    await this.remote.putBlob(s.hash,s.bytes);
    proposals[path] = {hash:s.hash,size:s.bytes.length,mtime:s.mtime};
    bases[path] = s.hash;
  }
}
