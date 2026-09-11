import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const vault = process.env.OBSIDIAN_TEST_VAULT;
const label = process.env.BENCHMARK_LABEL;
assert(vault && label && /^[a-z0-9-]+$/.test(label), 'Set OBSIDIAN_TEST_VAULT and a simple BENCHMARK_LABEL.');
// Read-only benchmark of the same index/local-file reconciliation reads.
// Never calls engine.sync, putBlob, commit, replace, or the connection probe.
const code = `(async () => {
  const p = app.plugins.plugins['s3-auto-sync'];
  if (!p || p.busy || p.device.enabled) throw new Error('Benchmark requires an idle plugin in manual mode');
  const state = JSON.stringify(p.device), engine = p.createEngine(), local = engine.local, remote = engine.remote;
  const original = remote.request, requests = [], passes = [];
  remote.request = async function(...args) {
    if (args[0] !== 'GET') throw new Error('Read-only benchmark refuses writes');
    const start = performance.now(), r = await original.apply(this,args);
    requests.push({method:args[0],status:r.status,bytes:r.bytes.byteLength,ms:Math.round(performance.now()-start)});
    return r;
  };
  try {
    for (let n=0;n<3;n++) {
      const start = performance.now(), m = (await remote.load()).manifest;
      if (!m) throw new Error('An existing index is required');
      const paths = new Set([...await local.paths(),...Object.keys(m.files),...Object.keys(p.device.state.base)]);
      let reads=0,hits=0,pending=0;
      for (const path of paths) {
        const entry=m.files[path], hash=entry&&!entry.deleted?entry.hash:null;
        const cached=local.cachedHash?.(path);
        if (cached!==undefined && cached===hash) {hits++;continue;}
        const current=await local.read(path);reads++;if ((current?.hash??null)!==hash) pending++;
      }
      passes.push({pass:n+1,files:paths.size,reads,cacheHits:hits,pendingFiles:pending,ms:Math.round(performance.now()-start)});
    }
  } finally {remote.request=original;}
  return JSON.stringify({timestamp:new Date().toISOString(),version:p.manifest.version,readOnly:true,deviceStateUnchanged:state===JSON.stringify(p.device),automatic:p.device.enabled,passes,requests});
})()`;
const output = execFileSync('obsidian',[`vault=${vault}`,'eval',`code=${code}`],{encoding:'utf8',timeout:180_000});
const marker = output.lastIndexOf('=> ');
assert(marker >= 0, 'Obsidian returned no result');
const result = JSON.parse(output.slice(marker+3));
assert(result.deviceStateUnchanged && !result.automatic);
await writeFile(`reports/performance-${label}.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
