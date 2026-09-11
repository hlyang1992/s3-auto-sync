// @vitest-environment happy-dom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import S3AutoSync from '../src/main.ts';
import { App,installDOMHelpers,Notice,Setting,requestUrl } from './obsidian.mock.ts';
import { defaults } from '../src/model.ts';
import type { App as OApp,PluginManifest } from 'obsidian';
import { MemoryRemote,seed,client } from './helpers.ts';
const cfg={...defaults,endpoint:'https://account.r2.cloudflarestorage.com',bucket:'test-bucket',accessKeyId:'test-access',secretAccessKey:'test-secret'};
const manifest={id:'s3-auto-sync',name:'S3 Auto Sync',version:'0.1.0',minAppVersion:'1.8.7',description:'test',author:'test'};
const plugins:S3AutoSync[]=[];
async function advance(ms:number){await vi.advanceTimersByTimeAsync(ms);for(const p of plugins)await (p as any).inFlight?.catch(()=>{});}
function make(app=new App()){const p=new S3AutoSync(app as unknown as OApp,manifest as PluginManifest);plugins.push(p);return {p,app};}
beforeEach(()=>{installDOMHelpers();vi.useFakeTimers();vi.setSystemTime(10_000);Notice.messages=[];Setting.all=[];});
afterEach(()=>{for(const p of plugins){p.onunload();for(const fn of (p as any).domClean)fn();}plugins.length=0;vi.useRealTimers();vi.restoreAllMocks();});
function useRemote(p:S3AutoSync,remote=new MemoryRemote()){const r=Object.assign(remote,{check:vi.fn(async(_progress?: (text:string)=>void)=>{})});vi.spyOn(p,'store').mockReturnValue(r as any);return r;}
it('loads paused, registers automatic events and does not touch S3 before configuration',async()=>{const {p,app}=make();const r=useRemote(p);await p.onload();app.layout?.();await advance(60_000);expect(r.manifest).toBeNull();expect(app.events.size).toBe(4);expect(p.device.enabled).toBe(false);expect((p as any).commands.map((c:any)=>c.id)).toEqual(['resume','pause','pull-again','sync-now']);});
it('activates with an automatic startup pull then continuous upload',async()=>{const {p,app}=make();const r=useRemote(p);await seed(r);await app.put('local.md','mine');await p.onload();await p.activate(cfg);await advance(0);expect(app.store.has('note.md')).toBe(true);expect(r.manifest!.files['local.md']).toBeUndefined();await advance(1000);expect(r.manifest!.files['local.md']).toBeDefined();expect(p.device.lastSync).toBeDefined();await p.pause();});
it('persists activation per device and resumes automatically after vault layout readiness',async()=>{const {p,app}=make();const r=useRemote(p);await p.onload();await p.activate(cfg);await advance(1000);p.onunload();const next=make(app).p;(next as any).saved=cfg;useRemote(next,r);await next.onload();expect(next.status).toContain('等待笔记库加载');app.layout?.();await advance(1000);expect(next.status).toContain('已同步');await next.pause();});
it('refuses to run concurrently with the old plugin',async()=>{const {p,app}=make();const r=useRemote(p);await p.onload();app.plugins.plugins['remotely-save']={};await expect(p.activate(cfg)).rejects.toThrow('停用');expect(r.check).not.toHaveBeenCalled();});
it('does not auto-start on another device merely because iCloud copied settings',async()=>{const {p}=make();(p as any).saved=cfg;const r=useRemote(p);await p.onload();await advance(30_000);expect(p.device.enabled).toBe(false);expect(r.manifest).toBeNull();});
it('pausing during connection checking prevents a late activation',async()=>{const {p}=make();const r=useRemote(p);let resolve!:()=>void;r.check.mockImplementation(()=>new Promise<void>(yes=>resolve=yes));await p.onload();const start=p.activate(cfg);await advance(0);await p.pause();resolve();await start;await advance(60_000);expect(p.device.enabled).toBe(false);expect(r.manifest).toBeNull();});
it('does not create duplicate schedulers when start is clicked twice',async()=>{const {p}=make();const r=useRemote(p);await p.onload();await Promise.all([p.activate(cfg),p.activate(cfg)]);expect(r.check).toHaveBeenCalledTimes(1);await p.pause();});
it('does not remain enabled after a connection check failure',async()=>{const {p}=make();const r=useRemote(p);r.check.mockRejectedValue(Error('denied'));await p.onload();await expect(p.activate(cfg)).rejects.toThrow('denied');expect(p.device.enabled).toBe(false);});
it('resets local baseline when selecting a different remote bucket',async()=>{const {p}=make();useRemote(p);await p.onload();await p.activate(cfg);await advance(1000);await p.pause();p.device.state.base['old.md']='a'.repeat(64);await p.activate({...cfg,bucket:'other-bucket'});expect(p.device.state.base['old.md']).toBeUndefined();await p.pause();});
it('rejects malformed local baseline without interpreting it as deletion',async()=>{const app=new App();app.local.set('s3-auto-sync',{enabled:true,identity:'a',state:{base:{'../evil':'bad'}}});const {p}=make(app);await p.onload();expect(p.device.enabled).toBe(false);});
it('uses Obsidian requestUrl for authenticated requests without browser CORS',async()=>{const {p}=make();await p.onload();requestUrl.mockResolvedValue({status:404,headers:{},arrayBuffer:new ArrayBuffer(0)});expect(await p.store(cfg).load()).toEqual({manifest:null,etag:null});expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({throw:false,method:'GET'}));});
it('settings default to manual, save without requests, sync on click and toggle automation',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();p.config=cfg;const tab=(p as any).tabs[0];tab.display();
 expect(Setting.all.flatMap(s=>s.texts).filter(t=>t.inputEl.type==='password')).toHaveLength(2);
 expect(Setting.all.find(s=>s.name==='自动同步')!.toggles[0].value).toBe(false);
 await Setting.all.flatMap(s=>s.buttons).find(b=>b.text==='保存 S3 配置')!.click();
 expect(r.check).not.toHaveBeenCalled();expect(p.device.enabled).toBe(false);
 await Setting.all.flatMap(s=>s.buttons).find(b=>b.text==='立即同步')!.click();
 expect(r.manifest).not.toBeNull();expect(p.device.enabled).toBe(false);
 await Setting.all.filter(s=>s.name==='自动同步').at(-1)!.toggles[0].change(true);
 expect(p.device.enabled).toBe(true);
 await Setting.all.filter(s=>s.name==='自动同步').at(-1)!.toggles[0].change(false);
 expect(p.device.enabled).toBe(false);
});
it('events, focus, visibility and reconnect trigger automatic catch-up',async()=>{const {p,app}=make();useRemote(p);await p.onload();await p.activate(cfg);await advance(1000);await app.put('new.md','new');app.emit('modify');window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));await advance(0);expect(p.device.state.base['new.md']).toBeDefined();await p.pause();});
it('commands resume, pause and pull-again recover deleted local files',async()=>{const {p,app}=make();const r=useRemote(p);await seed(r);await p.onload();p.config=cfg;const commands=(p as any).commands;commands.find((c:any)=>c.id==='resume').callback();await advance(0);await advance(1000);commands.find((c:any)=>c.id==='pause').callback();await advance(0);expect(p.device.enabled).toBe(false);app.store.delete('note.md');commands.find((c:any)=>c.id==='pull-again').callback();await advance(0);await advance(1000);expect(app.store.has('note.md')).toBe(true);await p.pause();});
it('reports command and startup errors without throwing an unhandled promise',async()=>{const {p,app}=make();await p.onload();(p as any).commands.find((c:any)=>c.id==='resume').callback();await advance(0);expect(p.status).toContain('Endpoint');p.device.enabled=true;p.device.identity='mismatched';p.config=cfg;vi.spyOn(p as any,'identity').mockResolvedValue('different');app.layout?.();await advance(0);expect(p.status).toContain('配置已变化');});
it('shows an actionable conflict notice',async()=>{const {p,app}=make();const r=useRemote(p);await seed(r);await app.put('note.md','local conflict');await p.onload();await p.activate(cfg);await advance(0);expect(Notice.messages,p.status).toEqual(expect.arrayContaining([expect.stringContaining('冲突')]));await p.pause();});
it('reports background errors, automatically retries and suppresses notices after unload',async()=>{const {p}=make();const r=useRemote(p);r.failLoad=true;await p.onload();await p.activate(cfg);await advance(0);expect(p.status).toContain('offline');r.failLoad=false;await advance(5000);await advance(1000);expect(p.status).toContain('已同步');p.onunload();await advance(60_000);});
it('settings callbacks update draft values without persisting before start',async()=>{const {p}=make();await p.onload();(p as any).tabs[0].display();const s=Setting.all;for(const row of s){for(const t of row.texts)t.change('typed');for(const t of row.toggles)t.change(false);}expect(p.config).toEqual(defaults);});
it('unload during connection checking prevents later activation',async()=>{const {p}=make();const r=useRemote(p);let done!:()=>void;r.check.mockImplementation(()=>new Promise<void>(resolve=>done=resolve));await p.onload();const starting=p.activate(cfg);await advance(0);p.onunload();done();await starting;expect(p.device.enabled).toBe(false);});
it('reports pull-again failure instead of starting with invalid credentials',async()=>{const {p}=make();await p.onload();(p as any).commands.find((c:any)=>c.id==='pull-again').callback();await advance(0);expect(p.status).toContain('Endpoint');});
it('saving S3 config in manual mode never calls the network even after edits, reconnect and reload',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();await p.configure(cfg);app.layout?.();
 await app.put('local.md','pending');app.emit('modify');window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));
 await advance(300_000);expect(r.check).not.toHaveBeenCalled();expect(r.manifest).toBeNull();expect(p.device.enabled).toBe(false);
 p.onunload();const next=make(app).p;(next as any).saved=cfg;useRemote(next,r);await next.onload();app.layout?.();await advance(300_000);
 expect(r.manifest).toBeNull();expect(next.status).toContain('手动同步');
});
it('one manual click pulls first and then uploads, with no subsequent scheduled activity',async()=>{
 const {p,app}=make();const r=useRemote(p);await seed(r);await app.put('local.md','pending');await p.onload();
 const runs:string[]=[];const load=r.load.bind(r),commit=r.commit.bind(r);
 r.load=async()=>{runs.push('load');return load();};r.commit=async(...args)=>{expect(app.store.has('note.md')).toBe(true);runs.push('commit');return commit(...args);};
 await p.syncNow(cfg);expect(app.store.has('note.md')).toBe(true);expect(r.manifest!.files['local.md']).toBeDefined();expect(p.device.enabled).toBe(false);
 const calls=runs.length;await app.put('later.md','later');await advance(300_000);expect(runs.length).toBe(calls);expect(r.manifest!.files['later.md']).toBeUndefined();
});
it('manual failures remain manual and never schedule a retry',async()=>{
 const {p}=make();const r=useRemote(p);r.failLoad=true;await p.onload();await expect(p.syncNow(cfg)).rejects.toThrow('offline');
 const count=r.check.mock.calls.length;await advance(300_000);expect(r.check).toHaveBeenCalledTimes(count);expect(p.device.enabled).toBe(false);expect(p.status).toContain('offline');
});
it('manual sync still requires conditional-write connection verification',async()=>{
 const {p}=make();const r=useRemote(p);r.check.mockRejectedValue(Error('provider ignores If-Match'));await p.onload();await expect(p.syncNow(cfg)).rejects.toThrow('If-Match');expect(r.manifest).toBeNull();
});
it('duplicate manual clicks produce one run and unload stops future commands',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();await Promise.all([p.syncNow(cfg),p.syncNow(cfg)]);expect(r.check).toHaveBeenCalledTimes(1);p.onunload();await p.syncNow(cfg);expect(r.check).toHaveBeenCalledTimes(1);
});
it('manual button during automatic mode stays serialized and resumes automation',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();await p.activate(cfg);await advance(0);await p.syncNow();expect(p.device.enabled).toBe(true);
 await app.put('after.md','new');await advance(3000);await advance(1000);expect(r.manifest!.files['after.md']).toBeDefined();await p.pause();
});
it('switching from automatic to manual prevents changes and wake events from syncing',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();await p.activate(cfg);await advance(1000);await p.pause();
 await app.put('manual-only.md','waiting');window.dispatchEvent(new Event('online'));await advance(300_000);expect(r.manifest!.files['manual-only.md']).toBeUndefined();expect(p.status).toContain('手动同步');
});
it('pause during manual connection checking prevents a late pull or upload',async()=>{
 const {p}=make();const r=useRemote(p);let resolve!:()=>void,started!:()=>void;const ready=new Promise<void>(yes=>started=yes);r.check.mockImplementation(()=>new Promise<void>(r=>{resolve=r;started();}));await p.onload();
 const work=p.syncNow(cfg);await ready;await p.pause();resolve();await work;expect(r.manifest).toBeNull();expect(p.device.enabled).toBe(false);
});
it('manual ribbon and command use the same one-shot operation and show errors',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();await p.configure(cfg);
 const sync=vi.spyOn(p,'syncNow');
 (p as any).ribbons[0].callback();await sync.mock.results[0].value;expect(r.manifest).not.toBeNull();
 await p.pause();r.failLoad=true;(p as any).commands.find((c:any)=>c.id==='sync-now').callback();
 await expect(sync.mock.results[1].value).rejects.toThrow('offline');expect(Notice.messages).toContain('offline');
});
it('UI save and automatic toggle failures show messages and stay manual',async()=>{
 const {p}=make();await p.onload();(p as any).tabs[0].display();
 await Setting.all.flatMap(s=>s.buttons).find(b=>b.text==='保存 S3 配置')!.click();
 await Setting.all.filter(s=>s.name==='自动同步').at(-1)!.toggles[0].change(true);
 expect(Notice.messages.filter(m=>m.includes('Endpoint'))).toHaveLength(2);expect(p.device.enabled).toBe(false);
});
it('saving configuration waits for any running sync and then remains manual',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();await p.activate(cfg);await advance(0);
 await p.configure(cfg);expect(p.device.enabled).toBe(false);expect(p.status).toContain('配置已保存');const n=r.check.mock.calls.length;await advance(60_000);expect(r.check).toHaveBeenCalledTimes(n);
});
it('removes the settings import entry and provides an independent connection button',async()=>{
 const {p}=make();await p.onload();(p as any).tabs[0].display();
 expect((p as any).importConfig).toBeUndefined();expect(Setting.all.some(s=>s.name.includes('导入'))).toBe(false);
 expect(Setting.all.flatMap(s=>s.buttons).some(b=>b.text==='检查连接')).toBe(true);
});
it('checks unsaved configuration without persisting, initializing a remote, or changing sync mode',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();const before=structuredClone(p.device),saved=structuredClone((p as any).saved);
 await p.checkConnection(cfg);expect(p.store).toHaveBeenCalledWith(expect.objectContaining({bucket:cfg.bucket}));expect(r.check).toHaveBeenCalledOnce();expect(r.manifest).toBeNull();
 expect(p.config).toEqual(defaults);expect(p.device).toEqual(before);expect((p as any).saved).toEqual(saved);expect(app.store.size).toBe(0);expect(p.status).toContain('检查通过');
});
it('shows immediate busy state, updates progress in-place, and restores controls after failure',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();p.config=cfg;const tab=(p as any).tabs[0];tab.display();
 let fail!:(e:Error)=>void;r.check.mockImplementation((progress:any)=>{progress('检查连接 3/6 · 正在读取');return new Promise<void>((_,no)=>fail=no);});
 const btn=Setting.all.flatMap(s=>s.buttons).find(b=>b.text==='检查连接')!,work=btn.click();
 expect(btn.text).toBe('检查中…');expect(Setting.all.flatMap(s=>s.buttons).every(b=>b.disabled)).toBe(true);
 const state=tab.containerEl.querySelector('.s3-sync-state');expect(state.textContent).toContain('3/6');
 await vi.advanceTimersByTimeAsync(2000);expect(state.textContent).toContain('已用时 2 秒');
 fail(Error('S3 request timeout'));await work;expect(state.textContent).toContain('S3 request timeout');expect(state.textContent).not.toContain('已用时');
 expect(btn.text).toBe('检查连接');expect(Setting.all.flatMap(s=>s.buttons).every(b=>!b.disabled)).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('retains edited fields when connection checking fails or succeeds',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();p.config=cfg;(p as any).tabs[0].display();
 await Setting.all.find(s=>s.name==='Bucket')!.texts[0].change('draft-bucket');const button=Setting.all.flatMap(s=>s.buttons).find(b=>b.text==='检查连接')!;
 r.check.mockRejectedValueOnce(Error('denied'));await button.click();await button.click();expect(p.store).toHaveBeenLastCalledWith(expect.objectContaining({bucket:'draft-bucket'}));expect(p.config.bucket).toBe(cfg.bucket);
});
it('reports empty configuration validation directly in the visible settings status',async()=>{
 const {p}=make();await p.onload();const tab=(p as any).tabs[0];tab.display();
 await Setting.all.flatMap(s=>s.buttons).find(b=>b.text==='检查连接')!.click();expect(tab.containerEl.textContent).toContain('Endpoint');expect(p.busy).toBe(false);
});
it('deduplicates connection checks and gives feedback instead of ignoring another click',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();let done!:()=>void;r.check.mockImplementation(()=>new Promise<void>(yes=>done=yes));
 const checking=p.checkConnection(cfg);await p.checkConnection(cfg);await p.syncNow(cfg);await p.configure(cfg);expect(r.check).toHaveBeenCalledOnce();expect(Notice.messages.some(s=>s.includes('请等待'))).toBe(true);
 done();await checking;expect(r.manifest).toBeNull();
});
it('removes status listeners and elapsed timers when settings hide, redraw, or plugin unloads',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();p.config=cfg;const tab=(p as any).tabs[0];tab.display();tab.display();expect((p as any).listeners.size).toBe(1);
 let done!:()=>void;r.check.mockImplementation(()=>new Promise<void>(yes=>done=yes));const checking=p.checkConnection(cfg);expect(vi.getTimerCount()).toBe(1);
 tab.hide();expect(vi.getTimerCount()).toBe(0);expect((p as any).listeners.size).toBe(0);tab.display();expect(vi.getTimerCount()).toBe(1);p.onunload();done();await checking;expect(vi.getTimerCount()).toBe(0);expect(Notice.messages.some(s=>s.includes('检查通过'))).toBe(false);
});
it('shows full one-shot counts and a no-change completion notice, with a live settings status',async()=>{
 const {p,app}=make();const r=useRemote(p);await seed(r);await p.onload();p.config=cfg;await app.put('local.md','new');const tab=(p as any).tabs[0];tab.display();
 await Setting.all.flatMap(s=>s.buttons).find(b=>b.text==='立即同步')!.click();expect(p.status).toContain('上传 1、下载 1');expect(tab.containerEl.textContent).toContain('上传 1、下载 1');expect(Notice.messages.at(-1)).toContain('已同步');
 await p.syncNow();expect(p.status).toContain('没有需要同步的变化');expect(Notice.messages.at(-1)).toContain('没有需要同步的变化');
});
it('does not mark a successful pull as a completed sync when upload fails',async()=>{
 const {p,app}=make();const r=useRemote(p);await seed(r);await app.put('local.md','new');await p.onload();r.failUpload=true;
 await expect(p.syncNow(cfg)).rejects.toThrow('upload');expect(p.device.lastSync).toBeUndefined();expect(p.status).toContain('upload');
});
it('counts conflicts from the initial pull in the final manual sync notice',async()=>{
 const {p,app}=make();const r=useRemote(p);await seed(r);await app.put('note.md','different');await p.onload();await p.syncNow(cfg);
 expect(p.status).toContain('冲突副本 1');expect(Notice.messages.at(-1)).toContain('冲突副本 1');
});
it('waits for an independent check before the next automatic run without skipping the pull barrier',async()=>{
 const {p,app}=make();const r=useRemote(p);await seed(r);await p.onload();await p.activate(cfg);
 let done!:()=>void;r.check.mockImplementation(()=>new Promise<void>(yes=>done=yes));const checking=p.checkConnection(cfg);await vi.advanceTimersByTimeAsync(10);
 expect(app.store.size).toBe(0);done();await checking;await advance(0);expect(app.store.has('note.md')).toBe(true);expect(p.device.enabled).toBe(true);await p.pause();
});
it('refuses independent checks during a background sync',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();(p as any).syncing=true;await p.checkConnection(cfg);expect(r.check).not.toHaveBeenCalled();expect(Notice.messages.at(-1)).toContain('请等待');(p as any).syncing=false;
});
it('keeps background failures from replacing an active settings draft',async()=>{
 const {p}=make();await p.onload();const tab=(p as any).tabs[0];tab.display();p.report('unknown');expect(tab.containerEl.textContent).toContain('操作失败');
});
it('renders sync progress immediately and preserves busy labels through connection checking',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();p.config=cfg;const tab=(p as any).tabs[0];tab.display();
 let done!:()=>void,started!:()=>void;const ready=new Promise<void>(yes=>started=yes);r.check.mockImplementation(()=>new Promise<void>(yes=>{done=yes;started();}));
 const button=Setting.all.flatMap(s=>s.buttons).find(b=>b.text==='立即同步')!,work=button.click();expect(button.text).toBe('同步中…');expect(tab.containerEl.textContent).toContain('正在同步');
 await ready;expect(tab.containerEl.textContent).toContain('正在检查连接');done();await work;expect(button.text).toBe('立即同步');expect(button.disabled).toBe(false);expect(tab.containerEl.textContent).toContain('已同步');
});
it('reuses a verified configuration across manual runs, saves and mode changes',async()=>{
 const {p}=make();const r=useRemote(p);await p.onload();await p.checkConnection(cfg);await p.configure(cfg);await p.syncNow();await p.syncNow();await p.activate(cfg);await advance(0);await p.pause();expect(r.check).toHaveBeenCalledTimes(1);
 await p.checkConnection(cfg);expect(r.check).toHaveBeenCalledTimes(2);
});
it.each([{bucket:'other-bucket'},{secretAccessKey:'new-secret'},{accessKeyId:'new-access'},{region:'new-region'},{endpoint:'https://new.example.com'},{prefix:'other'},{pathStyle:false}])('rechecks the connection when any S3 configuration field changes: %j',async change=>{
 const {p}=make();const r=useRemote(p);await p.onload();await p.syncNow(cfg);await p.syncNow({...cfg,...change});expect(r.check).toHaveBeenCalledTimes(2);
});
it('invalidates connection verification after an error and never persists it across reload',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();await p.syncNow(cfg);r.failLoad=true;await expect(p.syncNow()).rejects.toThrow('offline');r.failLoad=false;await p.syncNow();expect(r.check).toHaveBeenCalledTimes(2);
 p.onunload();const next=make(app).p;(next as any).saved=cfg;useRemote(next,r);await next.onload();await next.syncNow();expect(r.check).toHaveBeenCalledTimes(1);
});
it('uses no file reads or blob transfers for an unchanged warm sync and rehashes only edited files',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();for(let i=0;i<40;i++)await app.put(`note-${i}.md`,'same');
 await p.syncNow(cfg);const reads=app.readCount,uploads=r.uploads,commits=r.commits;await p.syncNow();expect(app.readCount-reads).toBe(0);expect(r.uploads-uploads).toBe(0);expect(r.commits-commits).toBe(0);expect(r.check).toHaveBeenCalledTimes(1);
 const file=app.store.get('note-5.md')!.file;await app.vault.modifyBinary(file,new TextEncoder().encode('edit').buffer,{mtime:file.stat.mtime});const before=app.readCount;
 await p.syncNow();expect(app.readCount-before).toBe(2);expect(r.uploads-uploads).toBe(1);expect(p.status).toContain('上传 1');
});
it('detects same-size same-mtime edits via events and expires missed-event hints',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();await app.put('a.md','one');await p.syncNow(cfg);const original=r.manifest!.files['a.md'].hash;
 app.store.get('a.md')!.bytes=new TextEncoder().encode('two');app.emit('modify',app.store.get('a.md')!.file);await p.syncNow();expect(r.manifest!.files['a.md'].hash).not.toBe(original);
 const updated=r.manifest!.files['a.md'].hash;app.store.get('a.md')!.bytes=new TextEncoder().encode('six');await vi.advanceTimersByTimeAsync(300_000);await p.syncNow();expect(r.manifest!.files['a.md'].hash).not.toBe(updated);
});
it('clears fingerprints after app focus and rename, including folder changes',async()=>{
 const {p,app}=make();useRemote(p);await p.onload();await app.put('a.md','one');await p.syncNow(cfg);const local=(p as any).localFiles;
 expect(local.cachedHash('a.md')).toBeDefined();window.dispatchEvent(new Event('focus'));expect(local.cachedHash('a.md')).toBeUndefined();await p.syncNow();app.emit('rename',{path:'folder'});expect(local.cachedHash('a.md')).toBeUndefined();
});
it('still downloads remote edits and preserves simultaneous local edits with warm caches',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();await app.put('a.md','original');await p.syncNow(cfg);
 const other=client(r);await other.engine.sync(true);await other.local.set('a.md','remote-change');await other.engine.sync();await app.vault.modifyBinary(app.store.get('a.md')!.file,new TextEncoder().encode('local-change').buffer);
 await p.syncNow();expect(p.status).toContain('冲突副本 1');expect(new TextDecoder().decode(app.store.get('a.md')!.bytes)).toBe('remote-change');expect([...app.store.keys()].some(k=>k.includes('.conflict-'))).toBe(true);
});
it('propagates rename and deletion after the source file has a warm fingerprint',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();await app.put('a.md','original');await p.syncNow(cfg);
 const item=app.store.get('a.md')!;app.store.delete('a.md');item.file.path='folder/b.md';app.store.set(item.file.path,item);app.emit('rename',item.file,'a.md');await p.syncNow();
 expect(r.manifest!.files['a.md'].deleted).toBe(true);expect(r.manifest!.files['folder/b.md'].deleted).not.toBe(true);
 app.store.delete('folder/b.md');app.emit('delete',item.file);await p.syncNow();expect(r.manifest!.files['folder/b.md'].deleted).toBe(true);
});
it('refreshes a remotely edited file despite its valid local fingerprint',async()=>{
 const {p,app}=make();const r=useRemote(p);await p.onload();await app.put('a.md','original');await p.syncNow(cfg);
 const other=client(r);await other.engine.sync(true);await other.local.set('a.md','remote only');await other.engine.sync();await p.syncNow();
 expect(new TextDecoder().decode(app.store.get('a.md')!.bytes)).toBe('remote only');expect(p.status).toContain('上传 0、下载 1');
});
