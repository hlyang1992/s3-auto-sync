// @vitest-environment happy-dom
import { beforeEach,expect,it,vi } from 'vitest';
import { App,installDOMHelpers } from './obsidian.mock.ts';
import type { App as ObsidianApp } from 'obsidian';
import { VaultFiles } from '../src/vault.ts';
import { bytes,text } from './helpers.ts';
let app:App,local:VaultFiles;
beforeEach(()=>{installDOMHelpers();app=new App();local=new VaultFiles(app as unknown as ObsidianApp);});
it('enumerates regular files and excludes all hidden directories',async()=>{await app.put('a.md','x');await app.put('.obsidian/data.json','s');await app.put('a/.hidden','x');expect(await local.paths()).toEqual(['a.md']);});
it.each(['bad:name','CON.md','x '])('rejects unsafe local names %s',async p=>{await app.put(p,'x');await expect(local.paths()).rejects.toThrow('文件名');});
it('rejects case collisions',async()=>{await app.put('A.md','x');await app.put('a.md','x');await expect(local.paths()).rejects.toThrow('大小写');});
it('reads actual file bytes and rejects hidden or folder paths',async()=>{await app.put('x.md','x');expect(text((await local.read('x.md'))!.bytes)).toBe('x');expect(await local.read('missing.md')).toBeNull();await expect(local.read('.obsidian/x')).rejects.toThrow();app.directories.add('folder');await expect(local.read('folder')).rejects.toThrow('文件夹');});
it('creates parent folders before downloading a new file',async()=>{expect(await local.replace('a/b/c.md',null,bytes('remote'),123)).toBe(true);expect(app.directories).toEqual(new Set(['a','a/b']));expect((await local.read('a/b/c.md'))!.mtime).toBe(123);});
it('compares snapshot before overwriting and backs up old Markdown',async()=>{await app.put('a.md','old');const old=(await local.read('a.md'))!;expect(await local.replace('a.md','wrong',bytes('new'),2)).toBe(false);expect(await local.replace('a.md',old.hash,bytes('new'),2)).toBe(true);expect(text(app.store.get('.s3-auto-sync-recovery/'+old.hash)!.bytes)).toBe('old');expect(text((await local.read('a.md'))!.bytes)).toBe('new');});
it('uses atomic Markdown process to retain an edit at the final write boundary',async()=>{await app.put('a.md','old');const old=(await local.read('a.md'))!;app.processHook=()=>{app.store.get('a.md')!.bytes=bytes('typing');};expect(await local.replace('a.md',old.hash,bytes('remote'),2)).toBe(false);expect(text((await local.read('a.md'))!.bytes)).toBe('typing');});
it('fails without changing the note when recovery copy cannot be written',async()=>{await app.put('a.md','old');const old=(await local.read('a.md'))!;app.failWrite=true;await expect(local.replace('a.md',old.hash,bytes('new'),2)).rejects.toThrow('disk full');expect(text((await local.read('a.md'))!.bytes)).toBe('old');});
it('rejects malformed UTF-8 Markdown instead of silently changing it',async()=>{await app.put('a.md','old');const old=(await local.read('a.md'))!;await expect(local.replace('a.md',old.hash,new Uint8Array([255]),2)).rejects.toThrow();expect(text((await local.read('a.md'))!.bytes)).toBe('old');});
it('replaces binary attachments byte for byte',async()=>{await app.put('pic.png',new Uint8Array([1,2]));const old=(await local.read('pic.png'))!;expect(await local.replace('pic.png',old.hash,new Uint8Array([255,0]),2)).toBe(true);expect((await local.read('pic.png'))!.bytes).toEqual(new Uint8Array([255,0]));});
it('moves deletions to trash after saving a recovery copy',async()=>{await app.put('a.md','old');const old=(await local.read('a.md'))!;expect(await local.replace('a.md',old.hash,null,2)).toBe(true);expect(await local.read('a.md')).toBeNull();expect(app.store.has('.s3-auto-sync-recovery/'+old.hash)).toBe(true);expect(await local.replace('absent.md',null,null,2)).toBe(true);});
it('creates deterministic conflict filenames and reuses identical copies',async()=>{await app.put('dir/a.md','local');const s=(await local.read('dir/a.md'))!;const p=await local.preserve('dir/a.md',s);expect(p).toMatch(/dir\/a\.conflict-[a-f0-9]+\.md/);expect(await local.preserve('dir/a.md',s)).toBe(p);expect(text((await local.read(p))!.bytes)).toBe('local');});
it('handles conflict-name collisions and files without extensions',async()=>{await app.put('readme','a');const s=(await local.read('readme'))!,p=await local.preserve('readme',s);app.store.get(p)!.bytes=bytes('different');expect(await local.preserve('readme',s)).toBe(p+'-1');});
it('keeps the original if conflict-copy creation fails',async()=>{await app.put('a.md','original');const s=(await local.read('a.md'))!;app.failCreate=1;await expect(local.preserve('a.md',s)).rejects.toThrow('create');expect(text((await local.read('a.md'))!.bytes)).toBe('original');});
it('does not delete or overwrite binary files modified during backup',async()=>{for(const remove of [true,false]){app=new App();local=new VaultFiles(app as unknown as ObsidianApp);await app.put('a.bin','old');const old=(await local.read('a.bin'))!;const write=app.vault.adapter.writeBinary;app.vault.adapter.writeBinary=async(...args)=>{await write(...args);app.store.get('a.bin')!.bytes=bytes('new-local');};expect(await local.replace('a.bin',old.hash,remove?null:bytes('remote'),2)).toBe(false);expect(text((await local.read('a.bin'))!.bytes)).toBe('new-local');}});
it('caches hashes only, avoids duplicate reads, and expires the hint after five minutes',async()=>{
 const now=Date.now();const clock=vi.spyOn(Date,'now').mockReturnValue(now);
 try{await app.put('a.md','same');const s=(await local.read('a.md'))!;const count=app.readCount;expect(local.cachedHash('a.md')).toBe(s.hash);expect(app.readCount).toBe(count);
 clock.mockReturnValue(now+300_000);expect(local.cachedHash('a.md')).toBeUndefined();await local.read('a.md');clock.mockReturnValue(now-1);expect(local.cachedHash('a.md')).toBeUndefined();}
 finally{clock.mockRestore();}
});
it.each(['mtime','size','identity','delete','event'])('invalidates a hash after %s changes',async kind=>{
 await app.put('a.md','same');const old=(await local.read('a.md'))!;
 if(kind==='mtime')app.store.get('a.md')!.file.stat.mtime++;
 if(kind==='size')app.store.get('a.md')!.file.stat.size++;
 if(kind==='identity'){app.store.delete('a.md');await app.put('a.md','same');}
 if(kind==='delete')app.store.delete('a.md');
 if(kind==='event')local.invalidate('a.md');
 expect(local.cachedHash('a.md')).toBeUndefined();expect(old.hash).toHaveLength(64);
});
it('invalidates only the changed file until explicitly asked to refresh all files',async()=>{
 await app.put('a.md','A');await app.put('b.md','B');await local.read('a.md');const b=(await local.read('b.md'))!;
 local.invalidate('a.md');expect(local.cachedHash('a.md')).toBeUndefined();expect(local.cachedHash('b.md')).toBe(b.hash);local.invalidate();expect(local.cachedHash('b.md')).toBeUndefined();
});
it('does not cache a read interrupted by an event or an inconsistent file size',async()=>{
 await app.put('a.md','old');app.beforeRead=()=>local.invalidate('a.md');await local.read('a.md');expect(local.cachedHash('a.md')).toBeUndefined();
 app.beforeRead=undefined;app.store.get('a.md')!.file.stat.size=999;await local.read('a.md');expect(local.cachedHash('a.md')).toBeUndefined();
});
it('always rereads before replacing even if a cached hash looks unchanged',async()=>{
 await app.put('a.md','old');const old=(await local.read('a.md'))!;app.store.get('a.md')!.bytes=bytes('new');
 expect(local.cachedHash('a.md')).toBe(old.hash);expect(await local.replace('a.md',old.hash,bytes('remote'),2)).toBe(false);expect(text(app.store.get('a.md')!.bytes)).toBe('new');
});
it('excludes a custom non-hidden configuration directory from listing and all reads or writes',async()=>{
 app.vault.configDir='settings';await app.put('settings/plugins/secret.json','credentials');await app.put('settings-note.md','public');
 expect(await local.paths()).toEqual(['settings-note.md']);await expect(local.read('settings/plugins/secret.json')).rejects.toThrow('范围');
 await expect(local.replace('settings/plugins/secret.json',null,bytes('remote'),1)).rejects.toThrow('范围');expect(local.cachedHash('settings/plugins/secret.json')).toBeUndefined();
 expect(text(app.store.get('settings/plugins/secret.json')!.bytes)).toBe('credentials');
});
it('invalidates cached files when the vault configuration directory changes',async()=>{
 await app.put('settings/x.md','was a note');await local.read('settings/x.md');expect(local.cachedHash('settings/x.md')).toBeDefined();
 app.vault.configDir='settings';expect(local.cachedHash('settings/x.md')).toBeUndefined();await expect(local.read('settings/x.md')).rejects.toThrow('范围');
});
