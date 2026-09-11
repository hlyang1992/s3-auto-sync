import { App, TFile } from 'obsidian';
import { digest, syncPath, validPath } from './model.ts';
import type { LocalFiles, Snapshot } from './model.ts';

const decoder = new TextDecoder('utf-8',{fatal:true});
export class VaultFiles implements LocalFiles {
  private hashes = new Map<string,{file: TFile; hash: string; mtime: number; size: number; at: number}>();
  private epoch = 0;
  constructor(private app: App) {}
  private outsideConfig(path: string) { const dir = this.app.vault.configDir; return path !== dir && !path.startsWith(dir + '/'); }
  invalidate(path?: string) { this.epoch++; if (path === undefined) this.hashes.clear(); else this.hashes.delete(path); }
  cachedHash(path: string): string | undefined {
    if (!this.outsideConfig(path)) { this.hashes.delete(path); return undefined; }
    const c = this.hashes.get(path), f = this.app.vault.getAbstractFileByPath(path);
    if (c && f === c.file && f instanceof TFile && c.mtime === f.stat.mtime && c.size === f.stat.size && Date.now() - c.at >= 0 && Date.now() - c.at < 300_000) return c.hash;
    this.hashes.delete(path);
    return undefined;
  }
  async paths(): Promise<string[]> {
    const paths = this.app.vault.getFiles().map(f => f.path).filter(p => this.outsideConfig(p) && !p.split('/').some(s => s.startsWith('.')));
    if (paths.some(p => !validPath(p))) throw new Error('笔记库含无法跨平台同步的文件名，请检查尾部空格、保留名称或特殊字符。');
    const seen = new Set<string>();
    for (const p of paths) { const key = p.toLowerCase(); if (seen.has(key)) throw new Error('笔记库含仅大小写不同的文件名。'); seen.add(key); }
    return paths;
  }
  async read(path: string): Promise<Snapshot | null> {
    this.hashes.delete(path);
    if (!syncPath(path) || !this.outsideConfig(path)) throw new Error('拒绝访问同步范围之外的路径。');
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) return null;
    if (!(f instanceof TFile)) throw new Error('本地文件与文件夹名称冲突。');
    const mtime = f.stat.mtime, size = f.stat.size, epoch = this.epoch;
    const bytes = new Uint8Array(await this.app.vault.readBinary(f)), hash = await digest(bytes);
    if (epoch === this.epoch && f === this.app.vault.getAbstractFileByPath(path) && mtime === f.stat.mtime && size === f.stat.size && bytes.length === size) this.hashes.set(path,{file:f,hash,mtime,size,at:Date.now()});
    return {bytes,mtime,hash};
  }
  private async mkdir(path: string) {
    const parts = path.split('/'); parts.pop(); let dir = '';
    for (const part of parts) {
      dir = dir ? dir + '/' + part : part;
      if (!await this.app.vault.adapter.exists(dir)) {
        try { await this.app.vault.createFolder(dir); }
        catch (e) { if (!await this.app.vault.adapter.exists(dir)) throw e; }
      }
    }
  }
  async preserve(path: string, snapshot: Snapshot): Promise<string> {
    const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
    const stem = dot > slash ? path.slice(0,dot) : path, ext = dot > slash ? path.slice(dot) : '';
    for (let n = 0; n < 100; n++) {
      const target = `${stem}.conflict-${snapshot.hash.slice(0,12)}${n ? '-' + n : ''}${ext}`;
      const existing = await this.read(target);
      if (existing?.hash === snapshot.hash) return target;
      if (existing) continue;
      await this.mkdir(target);
      try { await this.app.vault.createBinary(target,snapshot.bytes.slice().buffer,{mtime:snapshot.mtime}); return target; }
      catch (e) { if (!await this.app.vault.adapter.exists(target)) throw e; }
    }
    throw new Error('无法创建冲突副本，已保留原文件。');
  }
  async replace(path: string, expected: string | null, bytes: Uint8Array | null, mtime: number): Promise<boolean> {
    const current = await this.read(path);
    if ((current?.hash ?? null) !== expected) return false;
    let f = this.app.vault.getAbstractFileByPath(path);
    if (!bytes) {
      if (f instanceof TFile) {
        // Keep an immutable recovery copy even if the user's trash is external.
        await this.backup(current!);
        if ((await this.read(path))?.hash !== expected) return false;
        await this.app.fileManager.trashFile(f);
      }
      return true;
    }
    if (!f) {
      await this.mkdir(path);
      if (this.app.vault.getAbstractFileByPath(path)) return false;
      await this.app.vault.createBinary(path,bytes.slice().buffer,{mtime});
      return true;
    }
    if (!(f instanceof TFile)) throw new Error('本地文件与文件夹名称冲突。');
    await this.backup(current!);
    if (f.extension.toLowerCase() === 'md') {
      const before = decoder.decode(current!.bytes), after = decoder.decode(bytes);
      let replaced = false;
      await this.app.vault.process(f, text => { if (text !== before) return text; replaced = true; return after; }, {mtime});
      return replaced;
    }
    if ((await this.read(path))?.hash !== expected) return false;
    await this.app.vault.modifyBinary(f,bytes.slice().buffer,{mtime});
    return true;
  }
  private async backup(s: Snapshot) {
    const dir = '.s3-auto-sync-recovery';
    if (!await this.app.vault.adapter.exists(dir)) await this.app.vault.adapter.mkdir(dir);
    const path = dir + '/' + s.hash;
    if (!await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.writeBinary(path,s.bytes.slice().buffer);
  }
}
