export interface Clock { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void; now(): number }
const clock: Clock = {setTimeout:(f,t) => setTimeout(f,t),clearTimeout:id => clearTimeout(id as ReturnType<typeof setTimeout>),now:() => Date.now()};
/** One request at a time. Startup pull must succeed before any upload is allowed. */
export class Scheduler {
  private timer: unknown; private running = false; private active = false; private pending = false;
  private startup = true; private failures = 0; private retryAt = 0; private firstChange = 0;
  constructor(private sync: (pullOnly: boolean) => Promise<void>, private error: (e: unknown) => void, private time: Clock = clock, private interval = 30_000) {}
  start() { if (this.active) return; this.active = true; this.startup = true; this.schedule(0); }
  stop() { this.active = false; this.pending = false; this.time.clearTimeout(this.timer); }
  change() {
    if (!this.active) return;
    if (this.running) { this.pending = true; return; }
    if (this.retryAt > this.time.now()) return;
    this.firstChange ||= this.time.now();
    this.schedule(Math.min(3000,Math.max(0,10_000-(this.time.now()-this.firstChange))));
  }
  wake() { if (this.active) { this.retryAt = 0; this.failures = 0; if (this.running) this.pending = true; else this.schedule(0); } }
  private schedule(delay: number) {
    this.time.clearTimeout(this.timer);
    if (this.active) this.timer = this.time.setTimeout(() => void this.run(),Math.max(delay,this.retryAt-this.time.now()));
  }
  private async run() {
    if (!this.active || this.running) return;
    this.running = true; this.pending = false; this.firstChange = 0;
    let success = false, wasStartup = this.startup;
    try { await this.sync(this.startup); this.startup = false; this.failures = 0; this.retryAt = 0; success = true; }
    catch (e) { this.failures++; this.retryAt = this.time.now()+Math.min(300_000,5000*2**Math.min(this.failures-1,6)); this.error(e); }
    finally {
      this.running = false;
      if (this.active) this.schedule(success && (wasStartup || this.pending) ? 1000 : success ? this.interval : 0);
    }
  }
}
