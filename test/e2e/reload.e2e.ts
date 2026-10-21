import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { pluginId } from './load';

describe('Immediate re-enable ownership in the app', () => {
 it('gates fresh readiness behind old create/process/persist and keeps third-reload state', async () => {
  const result = await browser.executeObsidian(async ({ app, obsidian }, id) => {
   return await new Function('app', 'id', 'version', `return (async () => {
    const plugins = app.plugins;
    const waitFor = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('readiness timeout'); };
    await waitFor(() => plugins.plugins[id]?.loaded);
    const assetHashes = {};
    const dir = plugins.plugins[id].manifest.dir;
    for (const name of ['main.js', 'manifest.json', 'styles.css']) {
     const digest = await crypto.subtle.digest('SHA-256', await app.vault.adapter.readBinary(dir + '/' + name));
     assetHashes[name] = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    const row = (id, text = 'remote', updated = '2026-10-01T08:00:00Z') => ({ id, text, updated, uri: 'https://example.com/' + id, created: '2026-10-01T08:00:00Z', document: { title: [id] } });
    const records = [];
    for (const mode of ['create', 'process', 'persist']) {
     const old = plugins.plugins[id];
     old.settings.username = 'jane'; old.settings.folder = 'Handoff old ' + mode;
     const oldId = 'OLD-' + mode, newId = 'NEW-' + mode;
     const oldKey = 'https://example.com/' + oldId;
     old.service.deps.client.search = async () => ({ ok: true, data: { rows: [row(oldId)] } });
     await old.persist();
     let release, enter; const gate = new Promise(r => release = r), entered = new Promise(r => enter = r);
     const create = app.vault.create.bind(app.vault), process = app.vault.process.bind(app.vault), save = old.saveData.bind(old);
     let operation;
     try {
      if (mode === 'create') {
       app.vault.create = async (...args) => { enter(); await gate; return create(...args); };
       operation = old.service.run();
      } else {
       await old.service.run(); await old.persist();
       if (mode === 'process') {
        const file = app.vault.getFileByPath(old.service.state.pages[oldKey].path);
        await process(file, text => text + '\\nUSER BYTES Ω\\n');
        old.service.deps.client.search = async () => ({ ok: true, data: { rows: [row(oldId, 'changed', '2026-10-02T08:00:00Z')] } });
        app.vault.process = async (...args) => { const text = await process(...args); enter(); await gate; return text; };
        operation = old.service.run();
       } else {
        let hold = true;
        old.saveData = async value => { const snapshot = JSON.parse(JSON.stringify(value)); if (hold) { hold = false; enter(); await gate; } return save(snapshot); };
        operation = old.persist();
       }
      }
      await entered;
      // Native callbacks may be synchronous even though plugin onload is async.
      await plugins.disablePlugin(id);
      const enable = plugins.enablePlugin(id);
      await new Promise(r => setTimeout(r, 30));
      const pending = plugins.plugins[id];
      const readyBeforeSettle = !!pending?.loaded;
      release(); await operation; await enable;
      app.vault.create = create; app.vault.process = process;
      await waitFor(() => plugins.plugins[id]?.loaded);
      const fresh = plugins.plugins[id];
      const oldMapping = fresh.service.state.pages[oldKey]?.path;
      const pendingRepair = fresh.service.state.pages[oldKey]?.metadataPending === true;
      fresh.settings.folder = 'Handoff fresh ' + mode; fresh.settings.properties = 'generation: fresh';
      const freshRows = [row(newId, 'fresh', '2026-10-03T08:00:00Z')];
      fresh.service.deps.client.search = async () => ({ ok: true, data: { rows: freshRows } });
      const synced = await fresh.service.run(); await fresh.persist();
      const durable = await fresh.loadData(); await old.persist();
      const staleSaveIgnored = JSON.stringify(await fresh.loadData()) === JSON.stringify(durable);
      await plugins.disablePlugin(id); await plugins.enablePlugin(id);
      await waitFor(() => plugins.plugins[id]?.loaded);
      const third = plugins.plugins[id];
      const settingsKept = third.settings.folder === 'Handoff fresh ' + mode && third.settings.properties === 'generation: fresh';
      const cursorKept = third.service.state.cursor === '2026-10-03T08:00:00Z';
      third.service.deps.client.search = async () => ({ ok: true, data: { rows: [...freshRows, row(oldId, mode === 'process' ? 'changed' : 'remote', '2026-10-02T08:00:00Z')] } });
      const replay = await third.service.run(); await third.persist();
      const freshFiles = app.vault.getFiles().filter(f => f.path.startsWith('Handoff fresh ' + mode + '/')).map(f => f.path);
      const oldText = await app.vault.read(app.vault.getFileByPath(oldMapping));
      records.push({ mode, readyBeforeSettle, oldMapping, pendingRepair, synced: synced.ok, staleSaveIgnored, settingsKept, cursorKept, replayCreated: replay.created, replayOK: replay.ok, freshFiles,
       repairCleared: !third.service.state.pages[oldKey]?.metadataPending, userBytesKept: mode !== 'process' || oldText.includes('USER BYTES Ω'), metadataRepaired: mode !== 'process' || oldText.includes('updated: 2026-10-02') });
     } finally { release(); app.vault.create = create; app.vault.process = process; }
    }
    return { version, assetHashes, records };
   })()`)(app, id, obsidian.apiVersion);
  }, pluginId);
  const expectedAssets = Object.fromEntries(['main.js', 'manifest.json', 'styles.css'].map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
  let lockPath = 'package-lock.json';
  if (!existsSync(lockPath)) {
   lockPath = '../../pnpm-lock.yaml';
   if (!statSync('../../pnpm-workspace.yaml', { throwIfNoEntry: false })?.isFile()
    || !statSync(lockPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('No standalone NPM lock or factory PNPM workspace lock found');
   }
  }
  const lockSha256 = createHash('sha256').update(readFileSync(lockPath)).digest('hex');
  console.log('CANDIDATE APP IMMEDIATE REENABLE', JSON.stringify({ ...result, lockPath, lockSha256 }));
  expect(result.assetHashes).toEqual(expectedAssets);
  expect(result.records).toHaveLength(3);
  for (const r of result.records) {
   expect(r.readyBeforeSettle).toBe(false); expect(r.oldMapping).toContain('Handoff old');
   expect(r.pendingRepair).toBe(r.mode === 'process');
   expect(r.synced).toBe(true); expect(r.staleSaveIgnored).toBe(true); expect(r.settingsKept).toBe(true); expect(r.cursorKept).toBe(true);
   expect(r.replayOK).toBe(true); expect(r.replayCreated).toBe(0); expect(r.freshFiles).toHaveLength(1);
   expect(r.repairCleared).toBe(true); expect(r.userBytesKept).toBe(true); expect(r.metadataRepaired).toBe(true);
  }
 });
});

describe('Final save recovery in the app', () => {
 it('retries a one-time final save failure on healthy enable before reading durable progress', async () => {
  const result = await browser.executeObsidian(async ({ app, obsidian }, id) => {
   return await new Function('app', 'id', 'version', `return (async () => {
    const plugins = app.plugins;
    const waitFor = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('recovery readiness timeout'); };
    await waitFor(() => plugins.plugins[id]?.loaded);
    const old = plugins.plugins[id], writes = [], errors = [];
    const save = old.saveData.bind(old), log = console.error;
    let fail = false, rejected = false;
    old.saveData = async value => {
     const snapshot = JSON.parse(JSON.stringify(value));
     writes.push({ failed: fail, pages: snapshot.state.pages, cursor: snapshot.state.cursor });
     if (fail) { fail = false; rejected = true; throw Error('controlled one-time final save failure'); }
     return save(snapshot);
    };
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    try {
     old.settings.username = 'jane'; old.settings.folder = 'Save recovery old';
     await old.persist();
     const row = (name, updated = '2026-10-04T08:00:00Z') => ({ id: name, text: 'recovery fixture', updated, created: updated, uri: 'https://example.com/' + name, document: { title: [name] } });
     const key = 'https://example.com/SAVE1111', oldRow = row('SAVE1111');
     old.service.deps.client.search = async () => ({ ok: true, data: { rows: [oldRow] } });
     await old.service.run();
     const path = old.service.state.pages[key].path;
     const noteCompleted = !!app.vault.getFileByPath(path);
     const memoryCursor = old.service.state.cursor;
     fail = true;
     await plugins.disablePlugin(id);
     await waitFor(() => rejected);
     await new Promise(r => setTimeout(r, 20));
     const durableBefore = await old.loadData();
     const missingBefore = !durableBefore.state.pages[key];
     const notice = Array.from(document.querySelectorAll('.notice')).some(n => n.textContent.includes('check storage before enabling again'));
     await plugins.enablePlugin(id);
     await waitFor(() => plugins.plugins[id]?.loaded);
     const fresh = plugins.plugins[id];
     const recoveredPath = fresh.service.state.pages[key]?.path;
     const cursorRecovered = fresh.service.state.cursor === memoryCursor;
     const recoveryWrites = writes.slice();
     fresh.settings.folder = 'Save recovery fresh'; fresh.settings.properties = 'generation: recovered';
     const newRow = row('SAVE2222', '2026-10-05T08:00:00Z');
     fresh.service.deps.client.search = async () => ({ ok: true, data: { rows: [oldRow, newRow] } });
     const synced = await fresh.service.run(); await fresh.persist();
     const durable = JSON.stringify(await fresh.loadData()), count = writes.length;
     await old.persist();
     const noOldSave = writes.length === count && JSON.stringify(await fresh.loadData()) === durable;
     await plugins.disablePlugin(id); await plugins.enablePlugin(id);
     await waitFor(() => plugins.plugins[id]?.loaded);
     const third = plugins.plugins[id];
     const newerSettings = third.settings.folder === 'Save recovery fresh' && third.settings.properties === 'generation: recovered';
     const mapping = third.service.state.pages[key]?.path;
     third.service.deps.client.search = async () => ({ ok: true, data: { rows: [oldRow, newRow] } });
     const replay = await third.service.run(); await third.persist();
     const files = app.vault.getFiles().filter(f => f.path.startsWith('Save recovery ')).map(f => f.path).sort();
     return { version, noteCompleted, path, missingBefore, notice, recoveredPath, cursorRecovered, recoveryWrites, noOldSave, newerSettings, mapping,
      created: synced.created, replayCreated: replay.created, replayOK: replay.ok, files, failures: errors };
    } finally { console.error = log; }
   })()`)(app, id, obsidian.apiVersion);
  }, pluginId);
  console.log('CANDIDATE APP FINAL SAVE RECOVERY', JSON.stringify(result));
  expect(result.noteCompleted).toBe(true); expect(result.missingBefore).toBe(true); expect(result.notice).toBe(true);
  expect(result.recoveredPath).toBe(result.path); expect(result.mapping).toBe(result.path); expect(result.cursorRecovered).toBe(true);
  expect(result.recoveryWrites.map((w: { failed: boolean }) => w.failed)).toEqual([false, true, false]);
  expect(result.recoveryWrites[2].pages['https://example.com/SAVE1111'].path).toBe(result.path);
  expect(result.noOldSave).toBe(true); expect(result.newerSettings).toBe(true); expect(result.created).toBe(1);
  expect(result.replayOK).toBe(true); expect(result.replayCreated).toBe(0);
  expect(result.files).toEqual(['Save recovery fresh/SAVE2222.md', 'Save recovery old/SAVE1111.md']);
  expect(result.failures).toHaveLength(1); expect(result.failures[0]).toContain('controlled one-time final save failure');
 });
});
