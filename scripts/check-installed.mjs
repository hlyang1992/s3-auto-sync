import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

// Explicitly invoke against a running vault. Clicks only the connection-check
// button; synthetic probes are cleaned, and note/index state must not change.
const vault = process.env.OBSIDIAN_TEST_VAULT;
assert(vault, 'Set OBSIDIAN_TEST_VAULT to the vault whose connection button should be checked.');
const code = `(async () => {
  const p = app.plugins.plugins['s-three-auto-sync'];
  if (!p || p.busy) throw new Error('Plugin unavailable or busy');
  app.setting.open(); app.setting.openTabById('s-three-auto-sync');
  const original = p.store, reader = original.call(p), before = await reader.load();
  const deviceBefore = JSON.stringify(p.device), requests = [], stages = [], keys = new Set(), start = Date.now();
  p.store = function(c) {
    const s = original.call(this,c), request = s.request;
    s.request = async function(...args) {
      const t = Date.now(), r = await request.apply(this,args), probe = args[1].includes('/probes/');
      if (probe) keys.add(args[1]);
      requests.push({method:args[0],scope:probe?'probe':args[1]===''?'listing':'other',status:r.status,ms:Date.now()-t});
      return r;
    };
    return s;
  };
  let unwatch = () => {};
  try {
    await new Promise((resolve,reject) => {
      unwatch = p.watch(() => {
        stages.push({status:p.status,busy:p.busy,ms:Date.now()-start});
        if (!p.busy) resolve();
      });
      const button = [...p.syncSettings.containerEl.querySelectorAll('button')].find(b => b.textContent==='检查连接');
      if (!button) reject(new Error('Check button missing')); else button.click();
    });
  } finally { unwatch(); p.store = original; }
  const after = await reader.load(), cleanup = [];
  for (const key of keys) cleanup.push((await reader.request('GET',key)).status);
  return JSON.stringify({timestamp:new Date().toISOString(),version:p.manifest.version,passed:p.status.includes('检查通过'),status:p.status,durationMs:Date.now()-start,automatic:p.device.enabled,busy:p.busy,strongETag:!!after.etag&&!after.etag.startsWith('W/'),manifestUnchanged:JSON.stringify(before.manifest)===JSON.stringify(after.manifest),deviceStateUnchanged:deviceBefore===JSON.stringify(p.device),probeCleanup:cleanup,requests,stages});
})()`;
const output = execFileSync('obsidian',[`vault=${vault}`,'eval',`code=${code}`],{encoding:'utf8',timeout:180_000});
const marker = output.lastIndexOf('=> ');
assert(marker >= 0, 'Obsidian returned no evaluation result');
const result = JSON.parse(output.slice(marker+3));
await writeFile('reports/installed-connection-check.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
assert(result.passed && !result.busy && result.strongETag, 'Connection check did not pass');
assert(result.manifestUnchanged && result.deviceStateUnchanged, 'A connection check changed sync state');
assert.deepEqual(result.probeCleanup,[404], 'The connection probe was not cleaned');
assert(result.requests.every(r => ['listing','probe'].includes(r.scope)), 'The button touched sync data');
