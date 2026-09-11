import { vi } from 'vitest';
export class TFile { extension:string; stat={mtime:1,size:0}; constructor(public path:string) { this.extension=path.split('.').pop()||''; } }
export class App {
  local=new Map<string,unknown>(); plugins={plugins:{} as Record<string,unknown>};
  store=new Map<string,{file:TFile;bytes:Uint8Array}>(); directories=new Set<string>(); events=new Map<string,((...args:any[])=>void)[]>();
  layout?:()=>void; processHook?:()=>void; failCreate=0; failWrite=false;
  readCount=0; beforeRead?:()=>void;
  loadLocalStorage(k:string){return this.local.get(k)||null;}
  saveLocalStorage(k:string,v:unknown){this.local.set(k,structuredClone(v));}
  async put(p:string,s:string|Uint8Array){await this.vault.createBinary(p,(typeof s==='string'?new TextEncoder().encode(s):s).slice().buffer);}
  emit(event:string,...args:any[]){for(const fn of this.events.get(event)||[])fn(...args);}
  fileManager={trashFile:async(f:TFile)=>{this.store.delete(f.path);this.emit('delete',f);}};
  workspace={onLayoutReady:(fn:()=>void)=>{this.layout=fn;}};
  vault={
    configDir:'.obsidian',
    getFiles:()=>[...this.store.values()].map(v=>v.file),
    getAbstractFileByPath:(p:string)=>this.store.get(p)?.file||(this.directories.has(p)?{path:p}:null),
    on:(event:string,fn:(...args:any[])=>void)=>{this.events.set(event,[...this.events.get(event)||[],fn]);return{event,fn};},
    readBinary:async(f:TFile)=>{this.beforeRead?.();this.readCount++;return this.store.get(f.path)!.bytes.slice().buffer;},
    createBinary:async(p:string,b:ArrayBuffer,options?:{mtime?:number})=>{
      if(this.failCreate-->0)throw Error('create failed');
      if(this.store.has(p))throw Error('exists');const file=new TFile(p);file.stat.mtime=options?.mtime??1;file.stat.size=b.byteLength;this.store.set(p,{file,bytes:new Uint8Array(b)});this.emit('create',file);return file;
    },
    modifyBinary:async(f:TFile,b:ArrayBuffer,options?:{mtime?:number})=>{if(this.failWrite)throw Error('disk full');f.stat.mtime=options?.mtime??1;f.stat.size=b.byteLength;this.store.set(f.path,{file:f,bytes:new Uint8Array(b)});this.emit('modify',f);},
    createFolder:async(p:string)=>{this.directories.add(p);},
    process:async(f:TFile,fn:(s:string)=>string,options?:{mtime?:number})=>{this.processHook?.();const before=new TextDecoder().decode(this.store.get(f.path)!.bytes),after=fn(before);await this.vault.modifyBinary(f,new TextEncoder().encode(after).buffer,options);return after;},
    adapter:{
      exists:async(p:string)=>this.store.has(p)||this.directories.has(p),
      mkdir:async(p:string)=>{this.directories.add(p);},
      read:async(p:string)=>{const s=this.store.get(p);if(!s)throw Error('not found');return new TextDecoder().decode(s.bytes);},
      writeBinary:async(p:string,b:ArrayBuffer)=>{if(this.failWrite)throw Error('disk full');this.store.set(p,{file:new TFile(p),bytes:new Uint8Array(b)});}
    }
  };
}
export class Notice {static messages:string[]=[];constructor(message:string){Notice.messages.push(message);}}
export class Plugin {
  saved:unknown; commands:any[]=[]; tabs:any[]=[]; registered:any[]=[]; domClean:(()=>void)[]=[];
  constructor(public app:App,public manifest:any){this.saved={};}
  async loadData(){return this.saved;}
  async saveData(d:unknown){this.saved=structuredClone(d);}
  addStatusBarItem(){return document.createElement('div');}
  addSettingTab(tab:unknown){this.tabs.push(tab);}
  addCommand(cmd:unknown){this.commands.push(cmd);}
  ribbons:{icon:string;title:string;callback:()=>void}[]=[];
  addRibbonIcon(icon:string,title:string,callback:()=>void){this.ribbons.push({icon,title,callback});return document.createElement('div');}
  registerEvent(ev:unknown){this.registered.push(ev);}
  registerDomEvent(el:EventTarget,name:string,fn:()=>void){el.addEventListener(name,fn);this.domClean.push(()=>el.removeEventListener(name,fn));}
}
export class PluginSettingTab {containerEl=document.createElement('div');constructor(..._args:any[]){} }
export class Setting {
  static all:Setting[]=[];name='';texts:any[]=[];buttons:any[]=[];toggles:any[]=[];
  constructor(public el:HTMLElement){Setting.all.push(this);}
  setName(s:string){this.name=s;return this;}setDesc(_s:string){return this;}
  addText(fn:(t:any)=>void){const t:any={inputEl:document.createElement('input'),setDisabled(v:boolean){this.inputEl.disabled=v;return this;},setValue(v:string){this.inputEl.value=v;return this;},setPlaceholder(v:string){this.inputEl.placeholder=v;return this;},onChange(cb:any){this.change=cb;return this;}};this.texts.push(t);fn(t);return this;}
  addButton(fn:(b:any)=>void){const b:any={disabled:false,setButtonText(v:string){this.text=v;return this;},setCta(){return this;},setDisabled(v:boolean){this.disabled=v;return this;},onClick(cb:any){this.click=cb;return this;}};this.buttons.push(b);fn(b);return this;}
  addToggle(fn:(t:any)=>void){const t:any={disabled:false,setDisabled(v:boolean){this.disabled=v;return this;},setValue(v:boolean){this.value=v;return this;},onChange(cb:any){this.change=cb;return this;}};this.toggles.push(t);fn(t);return this;}
}
export const requestUrl=vi.fn();
export function installDOMHelpers(){
  Object.defineProperty(HTMLElement.prototype,"win",{configurable:true,get(){return this.ownerDocument.defaultView;}});
  Object.assign(HTMLElement.prototype,{
    setText(this:HTMLElement,s:string){this.textContent=s;},empty(this:HTMLElement){this.replaceChildren();},
    createEl(this:HTMLElement,tag:string,opts:any={}){const el=document.createElement(tag);if(opts.text)el.textContent=opts.text;if(opts.cls)el.className=opts.cls;this.appendChild(el);return el;}
  });
}
