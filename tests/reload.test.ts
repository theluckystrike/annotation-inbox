import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import manifest from '../manifest.json';
import type Plugin from '../src/main';
// These tests count the loadData and saveData calls of the product's own handoff. The What's new controller
// (packages/hello) adds its own read and write at each enable; its tests cover them, so it is a no-op here.
vi.mock('../src/hello/index', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/hello/index')>()), setupHello: vi.fn(() => null) }));

const row = (id: string, text = 'remote', updated = '2026-10-01T08:00:00Z') => ({ id, text, updated, created: '2026-10-01T08:00:00Z', uri: `https://example.com/${id}`, document: { title: [id] } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
afterEach(() => { vi.restoreAllMocks(); });

describe('immediate module reload with a shared store', () => {
 it.each(['create', 'process', 'persist'])('hands off settled %s before fresh work and preserves third-reload replay', async mode => {
  const app = App.createConfigured__({ files: {} });
  let durable: unknown = null;
  let held = false;
  const entered = deferred(), gate = deferred();
  const saves: string[] = [];
  async function instance(label: string): Promise<Plugin> {
   vi.resetModules(); // A new module registry must still coordinate through the same App.
   const { default: Reloaded } = await import('../src/main');
   const p = new Reloaded(app as never, manifest as never);
   vi.spyOn(p, 'loadData').mockImplementation(async () => clone(durable));
   vi.spyOn(p, 'saveData').mockImplementation(async value => {
    const snapshot = clone(value);
    saves.push(label);
    if (label === 'old' && held) { held = false; entered.resolve(); await gate.promise; }
    durable = snapshot;
   });
   return p;
  }
  const old = await instance('old'); await old.onload();
  old.settings.username = 'jane'; old.settings.folder = 'Old'; await old.persist();
  old.service.deps.client.search = async () => ({ ok: true, data: { rows: [row('OLD11111')] } });
  let operation: Promise<unknown>;
  if (mode === 'create') {
   const real = old.app.vault.create.bind(old.app.vault);
   vi.spyOn(old.app.vault, 'create').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return real(...args); });
   operation = old.service.run();
  } else {
   await old.service.run(); await old.persist();
   if (mode === 'process') {
    const file = old.app.vault.getFileByPath('Old/OLD11111.md')!;
    await old.app.vault.process(file, s => s + '\nUSER BYTES Ω\n');
    const real = old.app.vault.process.bind(old.app.vault);
    vi.spyOn(old.app.vault, 'process').mockImplementation(async (...args) => { const text = await real(...args); entered.resolve(); await gate.promise; return text; });
    old.service.deps.client.search = async () => ({ ok: true, data: { rows: [row('OLD11111', 'changed', '2026-10-02T08:00:00Z')] } });
    operation = old.service.run();
   } else { held = true; operation = old.persist(); }
  }
  await entered.promise;
  old.onunload();
  const fresh = await instance('fresh');
  let ready = false; const loading = fresh.onload().then(() => { ready = true; });
  // Native disable/enable may return synchronously, before asynchronous onload completes.
  await new Promise(r => setTimeout(r, 20));
  const readyBeforeOldSettled = ready;
  gate.resolve(); await operation; await loading;
  expect(readyBeforeOldSettled).toBe(false);
  const oldKey = 'https://example.com/OLD11111';
  expect(fresh.service.state.pages[oldKey]?.path).toBe('Old/OLD11111.md');
  if (mode === 'process') expect(fresh.service.state.pages[oldKey]?.metadataPending).toBe(true);
  fresh.settings.username = 'jane'; fresh.settings.folder = 'Fresh'; fresh.settings.properties = 'generation: fresh';
  const freshRows = [row('NEW22222', 'fresh', '2026-10-03T08:00:00Z')];
  fresh.service.deps.client.search = async () => ({ ok: true, data: { rows: freshRows } });
  expect(await fresh.service.run()).toMatchObject({ ok: true, created: 1 }); await fresh.persist();
  const settled = clone(durable); await old.persist();
  expect(durable).toEqual(settled); // Even retained old callbacks cannot reopen persistence.
  fresh.onunload();
  const third = await instance('third'); await third.onload();
  expect(third.settings.folder).toBe('Fresh'); expect(third.settings.properties).toBe('generation: fresh');
  expect(third.service.state.cursor).toBe('2026-10-03T08:00:00Z');
  third.service.deps.client.search = async () => ({ ok: true, data: { rows: [...freshRows, row('OLD11111', mode === 'process' ? 'changed' : 'remote', '2026-10-02T08:00:00Z')] } });
  expect(await third.service.run()).toMatchObject({ ok: true, created: 0 });
  expect(third.app.vault.getFiles()).toHaveLength(2);
  if (mode === 'process') {
   expect(third.service.state.pages[oldKey]?.metadataPending).toBeUndefined();
   const file = third.app.vault.getFileByPath('Old/OLD11111.md')!;
   expect(await third.app.vault.read(file)).toContain('USER BYTES Ω');
   expect(await third.app.vault.read(file)).toContain('updated: 2026-10-02T08:00:00Z');
  }
  expect(saves.slice(saves.indexOf('fresh'))).not.toContain('old');
  third.onunload(); await third.persist();
 });
 it('serializes delayed immutable snapshots before saving newer settings', async () => {
  const { default: Reloaded } = await import('../src/main');
  const app = App.createConfigured__({ files: {} });
  const p = new Reloaded(app as never, manifest as never); await p.onload();
  const gate = deferred(), entered = deferred();
  const snapshots: { settings: { folder: string } }[] = [];
  const save = vi.spyOn(p, 'saveData').mockImplementation(async value => {
   snapshots.push(value);
   if (snapshots.length === 1) { entered.resolve(); await gate.promise; }
  });
  p.settings.folder = 'Old'; const first = p.persist(); await entered.promise;
  p.settings.folder = 'Fresh'; const second = p.persist();
  await new Promise(r => setTimeout(r, 20));
  const callsWhileHeld = save.mock.calls.length;
  const firstSnapshotFolder = snapshots[0]?.settings.folder;
  gate.resolve(); await first; await second;
  expect(callsWhileHeld).toBe(1); expect(firstSnapshotFolder).toBe('Old');
  expect(snapshots.map(s => s.settings.folder)).toEqual(['Old', 'Fresh']);
  p.onunload(); await p.persist();
 });

});


describe('explicit recovery after a final save fails', () => {
 it.each(['transient', 'repeated', 'metadata'])('recovers %s state through fresh module enables without old callbacks', async mode => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const app = App.createConfigured__({ files: {} });
  let durable: unknown = null, failures = 0, active = 0, maximumActive = 0;
  let hold = false;
  const entered = deferred(), gate = deferred();
  const loads: string[] = [], saves: { label: string; failed: boolean }[] = [];
  async function instance(label: string): Promise<Plugin> {
   vi.resetModules();
   const { default: Reloaded } = await import('../src/main');
   const p = new Reloaded(app as never, manifest as never);
   vi.spyOn(p, 'loadData').mockImplementation(async () => { loads.push(label); return clone(durable); });
   vi.spyOn(p, 'saveData').mockImplementation(async value => {
    active++; maximumActive = Math.max(maximumActive, active);
    const snapshot = clone(value), failed = failures > 0;
    if (failed) failures--;
    saves.push({ label, failed });
    try {
     if (hold) { hold = false; entered.resolve(); await gate.promise; }
     if (failed) throw Error('storage still unavailable');
     durable = snapshot;
    } finally { active--; }
   });
   return p;
  }
  const old = await instance('old'); await old.onload();
  old.settings.username = 'jane'; old.settings.folder = 'Old'; await old.persist();
  const key = 'https://example.com/OLD11111';
  old.service.deps.client.search = async () => ({ ok: true, data: { rows: [row('OLD11111')] } });
  await old.service.run();
  if (mode === 'metadata') {
   const file = app.vault.getFileByPath('Old/OLD11111.md')!;
   await app.vault.process(file, text => text + '\nUSER BYTES Ω\n');
   const process = app.vault.process.bind(app.vault), body = deferred(), settled = deferred();
   const spy = vi.spyOn(app.vault, 'process').mockImplementation(async (...args) => { const text = await process(...args); settled.resolve(); await body.promise; return text; });
   old.service.deps.client.search = async () => ({ ok: true, data: { rows: [row('OLD11111', 'changed', '2026-10-02T08:00:00Z')] } });
   const run = old.service.run(); await settled.promise;
   failures = 1; old.onunload(); body.resolve(); await run; spy.mockRestore();
  } else { failures = 1; old.onunload(); }
  await vi.waitFor(() => expect(saves.filter(s => s.failed)).toHaveLength(1));
  await new Promise(r => setTimeout(r, 20));
  const known = clone(old.service.state);
  expect(known.pages[key]?.path).toBe('Old/OLD11111.md');
  expect(known.pages[key]?.metadataPending === true).toBe(mode === 'metadata');
  expect(loads).toEqual(['old']);
  expect((durable as { state: { pages: object } }).state.pages).toEqual({});
  const beforeRetry = saves.length;
  if (mode === 'repeated') {
   failures = 2; hold = true;
   const first = await instance('failed-1');
   const firstLoad = first.onload().then(() => null, e => e as Error);
   expect(await Promise.race([entered.promise.then(() => true), firstLoad.then(() => false)])).toBe(true);
   const queued = await instance('failed-queued');
   const queuedLoad = queued.onload().then(() => null, e => e as Error);
   await new Promise(r => setTimeout(r, 20));
   expect(loads).toEqual(['old']); expect(saves).toHaveLength(beforeRetry + 1);
   gate.resolve();
   expect((await firstLoad)?.message).toContain('storage still unavailable');
   expect((await queuedLoad)?.message).toContain('storage still unavailable');
   first.onunload(); queued.onunload();
   await new Promise(r => setTimeout(r, 20));
   expect(saves).toHaveLength(beforeRetry + 2); // No background retry on failed enable/unload.
   expect(loads).toEqual(['old']);
   expect(old.service.state).toEqual(known);
  }
  const fresh = await instance('healthy'); await fresh.onload();
  expect(fresh.constructor).not.toBe(old.constructor);
  expect(loads).toEqual(['old', 'healthy']);
  expect(fresh.service.state).toEqual(known);
  expect(saves.at(-1)).toEqual({ label: 'old', failed: false });
  fresh.settings.folder = 'Fresh'; fresh.settings.properties = 'generation: newer';
  const rows = [row('OLD11111', mode === 'metadata' ? 'changed' : 'remote', '2026-10-02T08:00:00Z'), row('NEW22222', 'fresh', '2026-10-03T08:00:00Z')];
  fresh.service.deps.client.search = async () => ({ ok: true, data: { rows } });
  expect(await fresh.service.run()).toMatchObject({ ok: true, created: 1 }); await fresh.persist();
  const written = clone(durable), saveCount = saves.length;
  await old.persist(); expect(durable).toEqual(written); expect(saves).toHaveLength(saveCount);
  fresh.onunload();
  const third = await instance('third'); await third.onload();
  expect(third.settings.folder).toBe('Fresh'); expect(third.settings.properties).toBe('generation: newer');
  expect(third.service.state.pages[key]?.path).toBe('Old/OLD11111.md');
  expect(third.service.state.pages[key]?.metadataPending).toBeUndefined();
  expect(third.service.state.cursor).toBe('2026-10-03T08:00:00Z');
  third.service.deps.client.search = async () => ({ ok: true, data: { rows } });
  expect(await third.service.run()).toMatchObject({ ok: true, created: 0, unchanged: 2 });
  expect(app.vault.getFiles().map(f => f.path).sort()).toEqual(['Fresh/NEW22222.md', 'Old/OLD11111.md']);
  if (mode === 'metadata') {
   expect(await app.vault.read(app.vault.getFileByPath('Old/OLD11111.md')!)).toContain('USER BYTES Ω');
   expect(await app.vault.read(app.vault.getFileByPath('Old/OLD11111.md')!)).toContain('updated: 2026-10-02T08:00:00Z');
  }
  expect(maximumActive).toBe(1);
  expect(saves.slice(saves.findIndex(s => s.label === 'healthy'))).not.toContainEqual({ label: 'old', failed: false });
  third.onunload(); await third.persist();
 });
});
