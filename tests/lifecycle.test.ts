import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import Plugin from '../src/main';
import { DEFAULT_SECRET_ID } from '../src/settings';
import manifest from '../manifest.json';
import type { HttpReply } from '../src/client';
// These tests count the loadData and saveData calls of the product's own handoff. The What's new controller
// (packages/hello) adds its own read and write at each enable; its tests cover them, so it is a no-op here.
vi.mock('../src/hello/index', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/hello/index')>()), setupHello: vi.fn(() => null) }));

const plugins: Plugin[] = [];
afterEach(() => { plugins.forEach((p) => p.onunload()); plugins.length = 0; vi.restoreAllMocks(); });
const row = (id: string) => ({ id, created: '2026-10-01T08:00:00Z', updated: '2026-10-01T08:00:00Z', uri: `https://example.com/${id}`, text: 'fixture', document: { title: [id] } });
const reply = (rows = [row('AAAA1111')]): HttpReply => ({ status: 200, json: { rows }, headers: {} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function setup() {
 const app = App.createConfigured__({ files: {} });
 const p = new Plugin(app as never, manifest as never); plugins.push(p); await p.onload();
 p.settings.username = 'jane'; p.app.secretStorage.setSecret(DEFAULT_SECRET_ID, 'controlled-fixture-token');
 return p;
}
describe('disable during sync', () => {
 it('does not paginate or write when the pending response settles after unload', async () => {
  const p = await setup(); const gate = deferred<HttpReply>();
  const http = vi.fn(() => gate.promise); p.service.deps.client.deps.http = http;
  const run = p.service.run(); p.onunload(); gate.resolve(reply(Array.from({ length: 200 }, () => row('AAAA1111'))));
  const result = await run;
  expect(result.ok).toBe(false); expect(result.message).toContain('disabled');
  expect(http).toHaveBeenCalledTimes(1); expect(p.app.vault.getFiles()).toHaveLength(0);
  expect(p.service.state.cursor).toBeNull(); expect((await p.service.run()).ok).toBe(false);
 });
 it.each(['retry', 'pagination'])('cancels a pending %s wait without sending another request', async (kind) => {
  const p = await setup(); const wait = deferred<void>();
  const sleep = vi.fn(() => wait.promise); p.service.deps.sleep = sleep;
  const http = vi.fn(() => Promise.resolve(kind === 'retry' ? { status: 429, json: null, headers: { 'Retry-After': '120' } } : reply(Array.from({ length: 200 }, () => row('AAAA1111')))));
  p.service.deps.client.deps.http = http;
  let settled = false; const run = p.service.run().then((r) => { settled = true; return r; });
  await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1)); p.onunload();
  try { await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300 }); }
  finally { wait.resolve(); await run; }
  expect(http).toHaveBeenCalledTimes(1); expect(p.app.vault.getFiles()).toHaveLength(0);
 });
 it('starts no later folder or note after a pending parent folder settles', async () => {
  const p = await setup(); p.settings.folder = 'Parent/Child'; const gate = deferred<void>();
  p.service.deps.client.deps.http = () => Promise.resolve(reply());
  const real = p.app.vault.createFolder.bind(p.app.vault);
  const folder = vi.spyOn(p.app.vault, 'createFolder').mockImplementation(async (path) => { await gate.promise; return real(path); });
  const create = vi.spyOn(p.app.vault, 'create');
  const run = p.service.run(); await vi.waitFor(() => expect(folder).toHaveBeenCalledTimes(1)); p.onunload(); gate.resolve();
  expect((await run).ok).toBe(false); expect(folder).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled();
  expect(p.app.vault.getFolderByPath('Parent')).not.toBeNull(); expect(p.app.vault.getFolderByPath('Parent/Child')).toBeNull();
 });
 it('keeps a settled create and its mapping, retains the cursor and retries without duplicates after reload', async () => {
  const p = await setup(); const gate = deferred<void>();
  p.service.deps.client.deps.http = () => Promise.resolve(reply([row('AAAA1111'), row('BBBB2222')]));
  const original = p.app.vault.create.bind(p.app.vault);
  const create = vi.spyOn(p.app.vault, 'create').mockImplementation(async (path, data) => { await gate.promise; return original(path, data); });
  const run = p.service.run(); await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1)); p.onunload(); gate.resolve();
  const result = await run; expect(result).toMatchObject({ ok: false, created: 1 });
  expect(create).toHaveBeenCalledTimes(1); expect(p.service.state.cursor).toBeNull(); expect(Object.keys(p.service.state.pages)).toHaveLength(1);
  create.mockRestore();
  const next = new Plugin(p.app, manifest as never); plugins.push(next); vi.spyOn(next, 'loadData').mockResolvedValue(JSON.parse(JSON.stringify({ settings: p.settings, state: p.service.state }))); await next.onload(); next.settings.username = 'jane';
  next.service.deps.client.deps.http = () => Promise.resolve(reply([row('AAAA1111'), row('BBBB2222')]));
  expect(await next.service.run()).toMatchObject({ ok: true, created: 1, unchanged: 1 });
  expect(p.app.vault.getFiles()).toHaveLength(2);
 });
 it.each(['cachedRead', 'process'])('starts no later mutation after a pending %s settles', async (method) => {
  const p = await setup(); p.service.deps.client.deps.http = () => Promise.resolve(reply()); await p.service.run();
  const cursor = p.service.state.cursor; const gate = deferred<void>();
  p.service.deps.client.deps.http = () => Promise.resolve(reply([{ ...row('AAAA1111'), updated: '2026-10-02T08:00:00Z', text: 'changed' }]));
  const original = p.app.vault[method as 'cachedRead'].bind(p.app.vault);
  const process = vi.spyOn(p.app.vault, 'process'); const fm = vi.spyOn(p.app.fileManager, 'processFrontMatter');
  // Preserve the real write/read; only its completion is controlled.
  const pending = vi.spyOn(p.app.vault, method as 'cachedRead').mockImplementation(async (...args) => { const value = await original(...args); await gate.promise; return value; });
  const run = p.service.run(); await vi.waitFor(() => expect(pending).toHaveBeenCalled()); p.onunload(); gate.resolve(); await run;
  expect(process).toHaveBeenCalledTimes(method === 'process' ? 1 : 0); expect(fm).not.toHaveBeenCalled(); expect(p.service.state.cursor).toBe(cursor);
  pending.mockRestore(); process.mockRestore(); fm.mockRestore();
  const next = new Plugin(p.app, manifest as never); plugins.push(next);
  vi.spyOn(next, 'loadData').mockResolvedValue(JSON.parse(JSON.stringify({ settings: p.settings, state: p.service.state })));
  await next.onload(); next.service.deps.client.deps.http = p.service.deps.client.deps.http;
  if (method === 'process') expect(next.service.state.pages['https://example.com/AAAA1111']?.metadataPending).toBe(true);
  expect(await next.service.run()).toMatchObject({ ok: true, updated: 1 });
  expect(next.service.state.pages['https://example.com/AAAA1111']?.metadataPending).toBeUndefined();
  const file = p.app.vault.getFileByPath('Annotation Inbox/AAAA1111.md')!;
  expect(await p.app.vault.read(file)).toContain('updated: 2026-10-02T08:00:00Z');
 });
});
