import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { pluginId } from './load';

// Only controlled local rows and deferred operations; no Hypothesis account or request.
describe('Annotation cancellation in the app', () => {
 it('stops a deferred response, a retry wait and a pending create, then safely reloads', async () => {
  const result = await browser.executeObsidian(async ({ app, obsidian }, id) => {
   return await new Function('app', 'id', 'version', `return (async () => {
    const plugins = app.plugins;
    const assetHashes = {};
    const dir = plugins.plugins[id].manifest.dir;
    for (const name of ['main.js', 'manifest.json', 'styles.css']) {
     const digest = await crypto.subtle.digest('SHA-256', await app.vault.adapter.readBinary(dir + '/' + name));
     assetHashes[name] = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    const row = (id) => ({ id, uri: 'https://example.com/' + id, text: 'fixture', created: '2026-10-01T08:00:00Z', updated: '2026-10-01T08:00:00Z', document: { title: [id] } });
    const records = [];
    for (const mode of ['response', 'retry', 'create']) {
     const p = plugins.plugins[id]; p.settings.username = 'jane'; p.settings.folder = 'Cancellation ' + mode;
     let release; const gate = new Promise(r => release = r); let entered; const started = new Promise(r => entered = r);
     let requests = 0; const create = app.vault.create.bind(app.vault); let creates = 0;
     p.service.deps.client.search = async () => { requests++; if (mode === 'response') { entered(); await gate; } return mode === 'retry' ? { ok: false, kind: 'rate', waitMs: 120000, message: 'fixture retry' } : { ok: true, data: { rows: [row('CAN11111'), row('CAN22222')] } }; };
     if (mode === 'retry') p.service.deps.sleep = () => { entered(); return gate; };
     if (mode === 'create') app.vault.create = async (...args) => { creates++; entered(); await gate; return create(...args); };
     try {
      const run = p.service.run(); await started; const cursor = p.service.state.cursor;
      await plugins.disablePlugin(id); release(); const res = await run;
      records.push({ mode, ok: res.ok, message: res.message, requests, creates, cursorKept: p.service.state.cursor === cursor,
       mapped: Object.keys(p.service.state.pages).length, files: app.vault.getFiles().filter(f => f.path.startsWith(p.settings.folder + '/')).length });
     } finally { release(); app.vault.create = create; }
     if (mode === 'create') {
      let saved;
      for (let attempt = 0; attempt < 100; attempt++) {
       saved = await p.loadData();
       if (Object.keys(saved?.state?.pages ?? {}).length === 1) break;
       await new Promise(r => setTimeout(r, 20));
      }
      records[records.length - 1].savedMappings = Object.keys(saved?.state?.pages ?? {}).length;
     }
     await plugins.enablePlugin(id);
     for (let attempt = 0; !plugins.plugins[id]?.loaded && attempt < 500; attempt++) await new Promise(r => setTimeout(r, 10));
     if (!plugins.plugins[id]?.loaded) throw Error('Annotation load did not finish');
     if (mode === 'create') {
      const next = plugins.plugins[id];
      next.service.deps.client.search = async () => ({ ok: true, data: { rows: [row('CAN11111'), row('CAN22222')] } });
      const retried = await next.service.run();
      records[records.length - 1].retry = { ok: retried.ok, created: retried.created, unchanged: retried.unchanged,
       files: app.vault.getFiles().filter(f => f.path.startsWith(next.settings.folder + '/')).length };
     }
    }
    return { version, records, assetHashes };
   })()`)(app, id, obsidian.apiVersion);
  }, pluginId);
  const expectedAssets = Object.fromEntries(['main.js', 'manifest.json', 'styles.css'].map((name) => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
  const lockPath = existsSync('package-lock.json') ? 'package-lock.json' : '../../pnpm-lock.yaml';
  const lockSha256 = createHash('sha256').update(readFileSync(lockPath)).digest('hex');
  console.log('CANDIDATE APP CANCELLATION', JSON.stringify({ ...result, lockPath, lockSha256 }));
  expect(result.assetHashes).toEqual(expectedAssets);
  expect(result.version).toMatch(/^1\.(13\.4|14\.4)$/);
  expect(result.records).toHaveLength(3);
  for (const record of result.records) {
   expect(record.ok).toBe(false); expect(record.message).toContain('disabled'); expect(record.requests).toBe(1); expect(record.cursorKept).toBe(true);
   expect(record.files).toBe(record.mode === 'create' ? 1 : 0);
   expect(record.creates).toBe(record.mode === 'create' ? 1 : 0);
   if (record.mode === 'create') { expect(record.savedMappings).toBe(1); expect(record.retry).toEqual({ ok: true, created: 1, unchanged: 1, files: 2 }); }
  }
 });
});
