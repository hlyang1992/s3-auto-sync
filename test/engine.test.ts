import { describe, expect, it } from 'vitest';
import { client, MemoryLocal, MemoryRemote, seed, text } from './helpers.ts';
import type { State } from '../src/model.ts';

describe('startup and ordinary sync',() => {
  it('pulls remote first without uploading unsynced local files',async () => {
    const r = new MemoryRemote(); await seed(r); const b = client(r); await b.local.set('local.md','local');
    const before = r.commits; await b.engine.sync(true);
    expect(b.local.get('note.md')).toBe('original'); expect(r.manifest!.files['local.md']).toBeUndefined(); expect(r.commits).toBe(before);
    await b.engine.sync(); expect(r.manifest!.files['local.md']).toBeDefined();
  });
  it('initial empty client never deletes remote files',async () => {const r = new MemoryRemote();await seed(r);const b = client(r);await b.engine.sync();expect(r.manifest!.files['note.md'].deleted).toBeUndefined();expect(b.local.get('note.md')).toBe('original');});
  it('preserves both versions on first contact',async () => {const r = new MemoryRemote();await seed(r);const b = client(r);await b.local.set('note.md','offline');await b.engine.sync(true);expect(b.local.get('note.md')).toBe('original');expect(b.local.preserved.map(p=>b.local.get(p))).toEqual(['offline']);await b.engine.sync();expect(Object.keys(r.manifest!.files)).toHaveLength(2);});
  it('does not compare clocks and uploads a change with an older timestamp',async () => {const r = new MemoryRemote();const a = await seed(r);await a.local.set('note.md','older-clock');a.local.files.get('note.md')!.mtime=1;await a.engine.sync();const b=client(r);await b.engine.sync();expect(b.local.get('note.md')).toBe('older-clock');});
  it('is idempotent and does not upload unchanged files',async () => {const r=new MemoryRemote();const a=await seed(r);const count=r.uploads;await a.engine.sync();await a.engine.sync();expect(r.uploads).toBe(count);expect(r.commits).toBe(1);});
  it('handles binary, zero-byte and Unicode files',async () => {const r=new MemoryRemote();const a=client(r);await a.local.set('中文/图 % &.png',new Uint8Array([0,255,32,128]));await a.local.set('空.md','');await a.engine.sync();const b=client(r);await b.engine.sync();expect(b.local.files.get('中文/图 % &.png')!.bytes).toEqual(new Uint8Array([0,255,32,128]));expect(b.local.get('空.md')).toBe('');});
  it('syncs local rename as one remote index commit',async () => {const r=new MemoryRemote();const a=await seed(r);const b=client(r);await b.engine.sync();await a.local.set('folder/renamed.md','original');a.local.files.delete('note.md');const n=r.commits;await a.engine.sync();expect(r.commits).toBe(n+1);await b.engine.sync();expect(b.local.get('note.md')).toBeUndefined();expect(b.local.get('folder/renamed.md')).toBe('original');});
  it('propagates deletion while retaining remote content for recovery',async () => {const r=new MemoryRemote();const a=await seed(r);const b=client(r);await b.engine.sync();const h=r.manifest!.files['note.md'].hash;a.local.files.delete('note.md');await a.engine.sync();await b.engine.sync();expect(b.local.get('note.md')).toBeUndefined();expect(text(await r.blob(h))).toBe('original');});
  it('recreates a previously deleted file intentionally',async () => {const r=new MemoryRemote();const a=await seed(r);a.local.files.delete('note.md');await a.engine.sync();await a.local.set('note.md','recreated');await a.engine.sync();expect(r.manifest!.files['note.md'].deleted).toBeUndefined();const b=client(r);await b.engine.sync();expect(b.local.get('note.md')).toBe('recreated');});
});
describe('conflicts and races',() => {
  it.each(['edit/edit','edit/delete','delete/edit'])('retains surviving contents for %s',async scenario => {
    const r=new MemoryRemote(),a=await seed(r),b=client(r);await b.engine.sync();
    if(scenario.startsWith('edit'))await a.local.set('note.md','A');else a.local.files.delete('note.md');
    if(scenario.endsWith('edit'))await b.local.set('note.md','B');else b.local.files.delete('note.md');
    await a.engine.sync();await b.engine.sync();await a.engine.sync();
    const all=[...b.local.files.values()].map(s=>text(s.bytes));
    if(scenario.startsWith('edit'))expect(all).toContain('A');
    if(scenario.endsWith('edit'))expect(all).toContain('B');
  });
  it('does not duplicate conflict files for identical edits',async () => {const r=new MemoryRemote(),a=await seed(r),b=client(r);await b.engine.sync();await a.local.set('note.md','same');await b.local.set('note.md','same');await a.engine.sync();const result=await b.engine.sync();expect(result.conflicts).toBe(0);expect(b.local.files.size).toBe(1);});
  it('merges concurrent disjoint commits without losing either file',async () => {const r=new MemoryRemote(),a=await seed(r),b=client(r);await b.engine.sync();await a.local.set('a.md','A');await b.local.set('b.md','B');r.beforeCommit=async()=>{await b.engine.sync();};await a.engine.sync();await b.engine.sync();expect(a.local.get('b.md')).toBe('B');expect(b.local.get('a.md')).toBe('A');});
  it('preserves both competing updates to the same file during CAS retry',async () => {const r=new MemoryRemote(),a=await seed(r),b=client(r);await b.engine.sync();await a.local.set('note.md','A');await b.local.set('note.md','B');r.beforeCommit=async()=>{await b.engine.sync();};await a.engine.sync();await b.engine.sync();expect([...b.local.files.values()].map(s=>text(s.bytes))).toEqual(expect.arrayContaining(['A','B']));});
  it('does not overwrite an edit made while remote download was in flight',async () => {const r=new MemoryRemote(),a=await seed(r),b=client(r);await b.engine.sync();await a.local.set('note.md','remote-new');await a.engine.sync();b.local.beforeReplace=async()=>b.local.set('note.md','typed-during-download');await b.engine.sync();expect(b.local.get('note.md')).toBe('typed-during-download');await b.engine.sync();expect([...b.local.files.values()].map(s=>text(s.bytes))).toEqual(expect.arrayContaining(['remote-new','typed-during-download']));});
  it('new device with stale content does not resurrect tombstones',async () => {const r=new MemoryRemote(),a=await seed(r);a.local.files.delete('note.md');await a.engine.sync();const b=client(r);await b.local.set('note.md','stale');await b.engine.sync();expect(b.local.get('note.md')).toBeUndefined();expect(b.local.get(b.local.preserved[0])).toBe('stale');expect(r.manifest!.files['note.md'].deleted).toBe(true);});
  it('bounds CAS contention and retries successfully later',async () => {const r=new MemoryRemote(),a=await seed(r);await a.local.set('new.md','new');r.rejectCommits=true;await expect(a.engine.sync()).rejects.toThrow('连续 5 次');r.rejectCommits=false;await a.engine.sync();expect(r.manifest!.files['new.md']).toBeDefined();});
});
describe('interruption and corrupt state',() => {
  it('failed upload never publishes a reference to missing content',async () => {const r=new MemoryRemote(),a=await seed(r);const n=r.commits;await a.local.set('new.md','new');r.failUpload=true;await expect(a.engine.sync()).rejects.toThrow();expect(r.commits).toBe(n);expect(r.manifest!.files['new.md']).toBeUndefined();r.failUpload=false;await a.engine.sync();expect(r.manifest!.files['new.md']).toBeDefined();});
  it('recovers an indeterminate successful commit after network loss',async () => {const r=new MemoryRemote(),a=await seed(r);await a.local.set('note.md','new');r.afterCommit=()=>{throw new Error('lost reply');};await expect(a.engine.sync()).rejects.toThrow('lost reply');r.afterCommit=undefined;await a.engine.sync();expect(a.local.files.size).toBe(1);expect(a.state.base['note.md']).toBe(r.manifest!.files['note.md'].hash);});
  it('recovers after crash between local write and checkpoint',async () => {const r=new MemoryRemote(),a=await seed(r),b=client(r);await b.engine.sync();const saved=structuredClone(b.state);await a.local.set('note.md','new');await a.engine.sync();const broken=client(r,b.local,saved,async()=>{throw new Error('disk full');});await expect(broken.engine.sync()).rejects.toThrow('disk full');const resumed=client(r,b.local,structuredClone(b.state));await resumed.engine.sync();expect(b.local.get('note.md')).toBe('new');expect(b.local.files.size).toBe(1);});
  it('offline startup does not mutate either side',async () => {const r=new MemoryRemote(),a=await seed(r);r.failLoad=true;const b=client(r);await b.local.set('local.md','keep');await expect(b.engine.sync(true)).rejects.toThrow('offline');expect(b.local.files.size).toBe(1);expect(a.local.get('note.md')).toBe('original');});
  it.each(['missing','identity','rollback','missing-file'])('fails closed on %s manifest',async kind => {const r=new MemoryRemote(),a=await seed(r);if(kind==='missing')r.manifest=null;else if(kind==='identity')r.manifest!.id='other';else if(kind==='rollback')r.manifest!.revision=0;else delete r.manifest!.files['note.md'];await expect(a.engine.sync()).rejects.toThrow();expect(a.local.get('note.md')).toBe('original');});
  it('bad download hash does not overwrite local content',async () => {const r=new MemoryRemote(),a=await seed(r),b=client(r);await b.engine.sync();await a.local.set('note.md','new');await a.engine.sync();r.blobs.set(r.manifest!.files['note.md'].hash,new Uint8Array([9]));await expect(b.engine.sync()).rejects.toThrow('校验');expect(b.local.get('note.md')).toBe('original');});
  it('mass disappearance does not propagate destructive deletion',async () => {const r=new MemoryRemote();const a=await seed(r,Object.fromEntries(Array.from({length:20},(_,i)=>[`${i}.md`,`${i}`])));a.local.files.clear();await expect(a.engine.sync()).rejects.toThrow('大量');expect(Object.values(r.manifest!.files).every(e=>!e.deleted)).toBe(true);});
  it('stop prevents remote writes',async () => {const r=new MemoryRemote(),a=client(r);await a.local.set('a.md','A');a.engine.stop();await expect(a.engine.sync()).rejects.toThrow('暂停');expect(r.manifest).toBeNull();});
  it('missing tombstones cannot silently resurrect a previously deleted file',async()=>{const r=new MemoryRemote(),a=await seed(r);a.local.files.delete('note.md');await a.engine.sync();delete r.manifest!.files['note.md'];await a.local.set('note.md','stale reappeared');await expect(a.engine.sync()).rejects.toThrow('缺少');});
  it('stopping in the middle of upload prevents manifest publication',async () => {const r=new MemoryRemote(),a=await seed(r);await a.local.set('new.md','new');const put=r.putBlob.bind(r);r.putBlob=async(h,b)=>{await put(h,b);a.engine.stop();};await expect(a.engine.sync()).rejects.toThrow('暂停');expect(r.manifest!.files['new.md']).toBeUndefined();});
  it('handles prototype-like filenames as ordinary own keys',async () => {const r=new MemoryRemote(),a=client(r);await a.local.set('__proto__','content');await a.local.set('constructor','other');await a.engine.sync();const b=client(r);await b.engine.sync();expect(b.local.get('__proto__')).toBe('content');expect(Object.hasOwn(a.state.base,'__proto__')).toBe(true);});
});
describe('multi-device convergence',() => {
  it('converges after 150 seeded interleaved edits, renames, deletions and reconnects',async () => {
    const r=new MemoryRemote();const devices=[await seed(r),client(r),client(r)];for(const d of devices)await d.engine.sync();let rng=47832;
    const rand=(n:number)=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng%n;};
    for(let step=0;step<150;step++) {
      const d=devices[rand(3)],path=`n${rand(8)}.md`;
      if(rand(4)===0)d.local.files.delete(path);else await d.local.set(path,`edit-${step}`);
      if(rand(3)!==0)await d.engine.sync();
      if(rand(5)===0)await devices[rand(3)].engine.sync(true);
    }
    for(let round=0;round<4;round++)for(const d of devices)await d.engine.sync();
    const expected=Object.entries(r.manifest!.files).filter(([,e])=>!e.deleted).map(([p,e])=>[p,e.hash]).sort();
    for(const d of devices)expect([...d.local.files].map(([p,s])=>[p,s.hash]).sort()).toEqual(expected);
  });
});
