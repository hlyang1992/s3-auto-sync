import { Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import { defaults, digest, syncPath, validateConfig } from './model.ts';
import type { Config, State } from './model.ts';
import { S3Store } from './s3.ts';
import { VaultFiles } from './vault.ts';
import { SyncEngine } from './engine.ts';
import type { SyncResult } from './engine.ts';
import { Scheduler } from './scheduler.ts';

interface DeviceData { enabled: boolean; identity: string; state: State; lastSync?: number }
const fresh = (): DeviceData => ({enabled:false,identity:'',state:{base:Object.create(null) as State['base']}});
export default class S3AutoSync extends Plugin {
  config: Config = {...defaults};
  device: DeviceData = fresh();
  status = '未配置';
  private statusEl!: HTMLElement;
  private scheduler?: Scheduler;
  private engine?: SyncEngine;
  private inFlight?: Promise<SyncResult>;
  private disposed = false;
  private working = false;
  private syncing = false;
  operation = '';
  started = 0;
  private listeners = new Set<() => void>();
  private syncSettings!: SyncSettings;
  private connectionCheck?: Promise<void>;
  private localFiles!: VaultFiles;
  private syncRemote?: {key: string; remote: S3Store};
  private verifiedConfig?: string;
  private generation = 0;
  async onload() {
    this.localFiles = new VaultFiles(this.app);
    this.config = {...defaults,...await this.loadData() as Partial<Config>};
    const d = this.app.loadLocalStorage(this.manifest.id) as DeviceData | null;
    if (d && typeof d.enabled === 'boolean' && typeof d.identity === 'string' && d.state?.base && typeof d.state.base === 'object' && !Array.isArray(d.state.base) && Object.entries(d.state.base).every(([p,v]) => syncPath(p) && (v === null || /^[a-f0-9]{64}$/.test(v)))) {
      this.device = {...d,state:{...d.state,base:Object.assign(Object.create(null) as State['base'],d.state.base)}};
    }
    this.statusEl = this.addStatusBarItem();
    this.setStatus(this.device.enabled ? '自动同步 · 等待笔记库加载' : '手动同步 · 点击“立即同步”开始');
    this.syncSettings = new SyncSettings(this);
    this.addSettingTab(this.syncSettings);
    this.addCommand({id:'resume',name:'继续自动同步',callback:() => { void this.activate(this.config).catch(e => this.report(e)); }});
    this.addCommand({id:'pause',name:'暂停自动同步',callback:() => { void this.pause(); }});
    this.addCommand({id:'pull-again',name:'重新拉取远端（保留本地差异副本）',callback:() => { void this.pullAgain().catch(e => this.report(e)); }});
    const syncNow = () => { void this.syncNow().catch(e => { this.report(e); new Notice(e instanceof Error ? e.message : '同步失败'); }); };
    this.addCommand({id:'sync-now',name:'立即同步',callback:syncNow});
    this.addRibbonIcon('refresh-cw','S3：立即同步',syncNow);
    const changed = (file?: {path: string}) => { this.localFiles.invalidate(file?.path); this.scheduler?.change(); };
    this.registerEvent(this.app.vault.on('create',changed));
    this.registerEvent(this.app.vault.on('modify',changed));
    this.registerEvent(this.app.vault.on('delete',changed));
    this.registerEvent(this.app.vault.on('rename',() => changed()));
    const wake = () => { this.localFiles.invalidate(); this.scheduler?.wake(); };
    this.registerDomEvent(window,'online',wake);
    this.registerDomEvent(window,'focus',wake);
    this.registerDomEvent(document,'visibilitychange',() => { if (!document.hidden) wake(); });
    this.app.workspace.onLayoutReady(() => { if (!this.disposed && this.device.enabled) void this.begin().catch(e => this.report(e)); });
  }
  onunload() { this.disposed = true; this.generation++; this.scheduler?.stop(); this.engine?.stop(); this.syncSettings.hide(); this.listeners.clear(); this.localFiles.invalidate(); }
  get busy() { return this.working || this.syncing; }
  watch(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private refresh() { for (const listener of this.listeners) listener(); }
  private startWork(operation: string) {
    if (this.disposed) return false;
    if (this.working) { new Notice('S3 正在处理，请等待当前操作结束。' + this.status); return false; }
    this.working = true; this.operation = operation; this.started = Date.now();
    this.setStatus('正在' + operation + '…');
    return true;
  }
  private finishWork() { this.working = false; this.operation = ''; this.refresh(); }
  private setStatus(s: string) { this.status = s; this.statusEl?.setText('S3：' + s); this.statusEl?.setAttribute('aria-label','S3 自动同步：' + s); this.refresh(); }
  private saveDevice = async () => { this.app.saveLocalStorage(this.manifest.id,this.device); };
  report(e: unknown) { this.verifiedConfig = undefined; const message = e instanceof Error ? e.message : '操作失败，请重试。'; this.setStatus(message); }
  store(c = this.config) {
    return new S3Store(c,async req => { const r = await requestUrl({...req,throw:false}); return {status:r.status,headers:r.headers,bytes:new Uint8Array(r.arrayBuffer)}; });
  }
  private async identity(c: Config) {
    const v = validateConfig(c);
    return digest(new TextEncoder().encode(JSON.stringify([v.endpoint,v.bucket,v.prefix,v.pathStyle])));
  }
  private checkOtherSync() {
    const plugins = (this.app as unknown as {plugins?: {plugins?: Record<string,unknown>}}).plugins?.plugins;
    if (plugins?.['remotely-save'] || plugins?.['remotely-sync']) throw new Error('请先在当前设备停用 Remotely Save / Remotely Sync，再启动 S3 Auto Sync。');
  }
  private async verifyConnection(c: Config, force = false) {
    const key = JSON.stringify(validateConfig(c));
    if (!force && this.verifiedConfig === key) return;
    this.verifiedConfig = undefined;
    this.setStatus('正在检查连接');
    await this.store(c).check(s => this.setStatus(s));
    if (!this.disposed) this.verifiedConfig = key;
  }
  /** Validate the draft using disposable probes only. Never save or sync notes. */
  async checkConnection(c: Config) {
    if (this.busy) { new Notice('S3 正在同步或检查，请等待当前操作结束。'); return; }
    if (!this.startWork('检查连接')) return;
    try {
      this.connectionCheck = this.verifyConnection(validateConfig(c),true);
      await this.connectionCheck;
      if (!this.disposed) { this.setStatus('连接检查通过 · 配置有效，可读取、写入并安全同步'); new Notice('S3 连接检查通过。未同步笔记；未保存的配置可点击“保存 S3 配置”。'); }
    } catch (e) { if (!this.disposed) this.report(e); throw e; }
    finally { this.connectionCheck = undefined; this.finishWork(); }
  }
  private async stopRunning() {
    this.scheduler?.stop(); this.engine?.stop();
    await this.inFlight?.catch(() => {});
    this.scheduler = undefined; this.engine = undefined;
  }
  async pause() { this.generation++; this.device.enabled = false; await this.stopRunning(); await this.saveDevice(); this.setStatus('手动同步 · 点击“立即同步”开始'); }
  /** Saving credentials never sends a request or starts a timer. */
  async configure(c: Config) {
    if (!this.startWork('保存配置')) return;
    try {
      const next = validateConfig(c);
      await this.pause();
      await this.persistConfig(next);
      this.setStatus('手动同步 · 配置已保存');
    } catch (e) { this.report(e); throw e; }
    finally { this.finishWork(); }
  }
  private async persistConfig(next: Config) {
    const identity = await this.identity(next);
    if (identity !== this.device.identity) this.device = {...fresh(),identity};
    this.config = next;
    await this.saveData(next);
    await this.saveDevice();
  }
  /** One click performs one pull-first sync, with no retries/timers in manual mode. */
  async syncNow(c: Config = this.config) {
    if (!this.startWork('同步')) return;
    const generation = ++this.generation, automatic = this.device.enabled;
    try {
      this.checkOtherSync();
      const next = validateConfig(c);
      await this.stopRunning();
      await this.persistConfig(next);
      if (this.disposed || generation !== this.generation) return;
      await this.verifyConnection(next);
      if (this.disposed || generation !== this.generation) return;
      this.device.enabled = automatic;
      await this.saveDevice();
      const engine = this.createEngine();
      this.engine = engine;
      const pulled = await this.runEngine(engine,true,true);
      if (this.disposed || generation !== this.generation) return;
      const pushed = await this.runEngine(engine,false,true);
      const total = {uploaded:pulled.uploaded+pushed.uploaded,downloaded:pulled.downloaded+pushed.downloaded,deleted:pulled.deleted+pushed.deleted,conflicts:pulled.conflicts+pushed.conflicts};
      if (!this.disposed && generation === this.generation) { this.complete(total); new Notice('S3：' + this.status); }
    } catch (e) {
      if (!this.disposed && generation === this.generation) this.report(e);
      throw e;
    } finally {
      this.finishWork();
      if (!this.disposed && generation === this.generation && automatic) await this.begin();
    }
  }
  async activate(c: Config) {
    if (!this.startWork('开启自动同步')) return;
    const generation = ++this.generation;
    try {
      this.checkOtherSync();
      const next = validateConfig(c);
      await this.stopRunning();
      this.device.enabled = false; await this.saveDevice();
      await this.verifyConnection(next);
      if (this.disposed || generation !== this.generation) return;
      await this.persistConfig(next);
      if (this.disposed || generation !== this.generation) return;
      this.device.enabled = true; await this.saveDevice();
      await this.begin();
    } catch (e) { this.report(e); throw e; }
    finally { this.finishWork(); }
  }
  private async begin() {
    const generation = this.generation;
    this.checkOtherSync();
    if (this.disposed || !this.device.enabled) return;
    if (await this.identity(this.config) !== this.device.identity) throw new Error('S3 配置已变化，请在设置中重新检查并启动。');
    if (this.disposed || generation !== this.generation || !this.device.enabled) return;
    const engine = this.createEngine();
    this.engine = engine;
    this.scheduler = new Scheduler(async pull => { await this.connectionCheck?.catch(() => {}); if (!this.disposed && !engine.stopped) await this.runEngine(engine,pull); }, e => { if (!this.disposed) this.report(e); });
    this.scheduler.start();
  }
  private createEngine() {
    const key = JSON.stringify(validateConfig(this.config));
    if (this.syncRemote?.key !== key) this.syncRemote = {key,remote:this.store()};
    return new SyncEngine(this.localFiles,this.syncRemote.remote,this.device.state,this.saveDevice,s => this.setStatus(s));
  }
  private complete(result: SyncResult) {
    const changes = result.uploaded + result.downloaded + result.deleted + result.conflicts;
    this.setStatus((this.device.enabled ? '自动同步' : '手动同步') + ' · 已同步 · ' + (changes ? `上传 ${result.uploaded}、下载 ${result.downloaded}、删除 ${result.deleted}、冲突副本 ${result.conflicts}` : '没有需要同步的变化'));
  }
  private async runEngine(engine: SyncEngine, pull: boolean, manual = false): Promise<SyncResult> {
    this.syncing = true;
    if (!this.working) this.started = Date.now();
    this.inFlight = (async () => {
        this.checkOtherSync();
        this.setStatus(pull ? '正在拉取远端' : '正在同步');
        const result = await engine.sync(pull);
        if (!pull) { this.device.lastSync = Date.now(); await this.saveDevice(); }
        if (!this.disposed) {
          if (pull) this.setStatus('远端拉取完成 · 正在准备上传本地变化');
          if (!pull && !manual) this.complete(result);
          if (result.conflicts && !manual) new Notice(`S3 同步：已保留 ${result.conflicts} 个 .conflict 冲突副本，请检查。`);
        }
        return result;
    })();
    try { return await this.inFlight; }
    finally { this.inFlight = undefined; this.syncing = false; this.refresh(); }
  }
  private async pullAgain() {
    await this.pause();
    this.device.state = {base:Object.create(null) as State['base']};
    await this.syncNow();
  }
}

class SyncSettings extends PluginSettingTab {
  private unwatch?: () => void;
  private timer?: number;
  constructor(private plugin: S3AutoSync) { super(plugin.app,plugin); }
  hide() { this.unwatch?.(); this.unwatch = undefined; if (this.timer !== undefined) this.containerEl.win.clearInterval(this.timer); this.timer = undefined; }
  display() {
    this.hide();
    const {containerEl} = this; containerEl.empty();
    const draft = {...this.plugin.config};
    containerEl.createEl('p',{text:'默认手动同步。填好配置后先检查连接，点击“立即同步”执行一轮；开启自动同步后，启动先拉取，再持续同步。'});
    const state = containerEl.createEl('p',{cls:'s3-sync-state'});
    state.setAttribute('role','status'); state.setAttribute('aria-live','polite');
    const controls: {setDisabled(disabled: boolean): unknown}[] = [];
    const field = (parent: HTMLElement,key: keyof Config,name: string,placeholder: string,secret = false) => {
      new Setting(parent).setName(name).addText(t => { t.setPlaceholder(placeholder).setValue(String(draft[key])).onChange(v => { (draft as unknown as Record<string,unknown>)[key] = v; }); if (secret) t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off'; controls.push(t); });
    };
    field(containerEl,'endpoint','Endpoint','https://账号.r2.cloudflarestorage.com');
    field(containerEl,'bucket','Bucket','笔记库专用桶名称');
    field(containerEl,'accessKeyId','Access Key','S3 Access Key',true);
    field(containerEl,'secretAccessKey','Secret Key','S3 Secret Key',true);
    const more = containerEl.createEl('details'); more.createEl('summary',{text:'高级设置（通常不用改）'});
    field(more,'region','Region','R2 自动使用 auto，其他默认 us-east-1');
    field(more,'prefix','远端目录','留空使用整个桶');
    new Setting(more).setName('路径式访问').setDesc('R2 通常开启；已有配置可以保持原值。').addToggle(t => { controls.push(t); t.setValue(draft.pathStyle).onChange(v => { draft.pathStyle = v; }); });
    const run = async (action: () => Promise<void>) => { try { await action(); } catch (e) { this.plugin.report(e); new Notice(e instanceof Error ? e.message : '操作失败'); } };
    let checkButton!: {setButtonText(text: string): unknown};
    new Setting(containerEl).setName('检查 S3 配置').setDesc('检查当前填写的连接、读写权限和冲突保护，并清理检查文件。不会同步笔记，也不会保存配置。单次网络请求最多等待 15 秒。').addButton(b => { checkButton = b; controls.push(b); b.setButtonText('检查连接').onClick(() => run(() => this.plugin.checkConnection(draft))); });
    containerEl.createEl('p',{text:'同步笔记和附件；隐藏目录和应用配置目录不参与同步。密钥保存在本地插件配置中，请勿分享 data.json。首次接入会保留同名差异文件为 .conflict 副本。',cls:'setting-item-description'});
    let automatic!: {setValue(value: boolean): unknown};
    new Setting(containerEl).setName('自动同步').setDesc('默认关闭。开启后启动拉取、修改后自动上传，每 30 秒检查远端；关闭后仅在你点击按钮时同步。').addToggle(t => { automatic = t; controls.push(t); t.setValue(this.plugin.device.enabled).onChange(enabled => run(() => enabled ? this.plugin.activate(draft) : this.plugin.pause())); });
    let syncButton!: {setButtonText(text: string): unknown};
    new Setting(containerEl).addButton(b => { controls.push(b); b.setButtonText('保存 S3 配置').onClick(() => run(async () => { await this.plugin.configure(draft); new Notice('配置已保存，当前为手动同步。'); })); }).addButton(b => { syncButton = b; controls.push(b); b.setButtonText('立即同步').setCta().onClick(() => run(() => this.plugin.syncNow(draft))); });
    const refresh = () => {
      const busy = this.plugin.busy;
      state.setText('当前状态：' + this.plugin.status + (busy ? ` · 已用时 ${Math.floor((Date.now() - this.plugin.started) / 1000)} 秒` : ''));
      state.setAttribute('aria-busy',String(busy));
      for (const c of controls) c.setDisabled(busy);
      checkButton.setButtonText(this.plugin.operation === '检查连接' ? '检查中…' : '检查连接');
      syncButton.setButtonText(this.plugin.operation === '同步' || (busy && !this.plugin.operation) ? '同步中…' : '立即同步');
      automatic.setValue(this.plugin.device.enabled);
      if (busy && this.timer === undefined) this.timer = containerEl.win.setInterval(refresh,1000);
      if (!busy && this.timer !== undefined) { containerEl.win.clearInterval(this.timer); this.timer = undefined; }
    };
    this.unwatch = this.plugin.watch(refresh); refresh();
  }
}
