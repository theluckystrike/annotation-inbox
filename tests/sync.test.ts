import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import { HypothesisClient, classify, type Http, type HttpReply, type HttpRequest } from '../src/client';
import { SyncService, emptyState, normalizeState, summary, PAGE_LIMIT, type SyncOptions } from '../src/sync';
import { searchQuery } from '../src/logic';

const USER = 'acct:jane@hypothes.is';
const TOKEN = 'secret-token-123';
const ts = (n: number): string => `2026-10-${String(1 + Math.floor(n / 100)).padStart(2, '0')}T08:${String(Math.floor((n % 100) / 2)).padStart(2, '0')}:${String((n % 2) * 30).padStart(2, '0')}.000000+00:00`;

function row(id: string, n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		created: ts(n),
		updated: ts(n),
		user: USER,
		uri: 'https://example.com/post',
		text: `note ${id}`,
		tags: [],
		target: [{ source: 'https://example.com/post', selector: [{ type: 'TextQuoteSelector', exact: `quote ${id}` }] }],
		document: { title: ['Example Post'] },
		links: { incontext: `https://hyp.is/${id}/example.com/post` },
		...over,
	};
}

interface Rig {
	svc: SyncService;
	app: App;
	calls: HttpRequest[];
	sleeps: number[];
	saves: { n: number };
	script: { rows: Record<string, unknown>[]; replies: HttpReply[] };
	opts: SyncOptions;
}

/** A sync service over an in-memory vault and a scripted Hypothesis. rows are served by search_after like the real API. */
function rig(rows: Record<string, unknown>[] = []): Rig {
	const app = App.createConfigured__({ files: {} });
	const calls: HttpRequest[] = [];
	const sleeps: number[] = [];
	const saves = { n: 0 };
	const script = { rows, replies: [] as HttpReply[] };
	const http: Http = (r) => {
		calls.push(r);
		const queued = script.replies.shift();
		if (queued) return Promise.resolve(queued);
		const after = new URLSearchParams(r.query).get('search_after');
		const sorted = [...script.rows].sort((a, b) => String(a.updated).localeCompare(String(b.updated)));
		const page = sorted.filter((x) => after === null || String(x.updated) > after).slice(0, PAGE_LIMIT);
		return Promise.resolve({ status: 200, json: { total: page.length, rows: page }, headers: {} });
	};
	const opts: SyncOptions = { user: USER, folder: 'Annotation Inbox', template: '{title}' };
	const client = new HypothesisClient({ getToken: () => TOKEN, http });
	const svc = new SyncService(
		{ app: app as never, client, options: () => opts, now: () => Date.parse('2026-10-11T00:00:00Z'), sleep: (ms) => (sleeps.push(ms), Promise.resolve()), save: () => void saves.n++ },
		emptyState(),
	);
	return { svc, app, calls, sleeps, saves, script, opts };
}

const read = (r: Rig, path: string): Promise<string> => r.app.vault.adapter.read(path);

describe('sync', () => {
	it('makes one note per page with front matter and blocks', async () => {
		const r = rig([row('AAAA1111', 1), row('BBBB2222', 2, { uri: 'https://other.org/x', document: { title: ['Other'] } })]);
		const res = await r.svc.run();
		expect(res).toMatchObject({ ok: true, fetched: 2, created: 2, updated: 0 });
		const text = await read(r, 'Annotation Inbox/Example Post.md');
		expect(text).toContain('url: "https://example.com/post"');
		expect(text).toContain('<!-- ai:AAAA1111 ');
		expect(text).toContain('> quote AAAA1111');
		expect(await read(r, 'Annotation Inbox/Other.md')).toContain('<!-- ai:BBBB2222 ');
		expect(Object.keys(r.svc.state.pages)).toHaveLength(2);
	});

	it('sends the token only in the Authorization header and asks for your annotations oldest first', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		const first = r.calls[0];
		expect(first?.kind).toBe('search');
		expect(first?.query).toBe(searchQuery(USER, null, 200));
		expect(first?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(first?.headers.Accept).toBe('application/vnd.hypothesis.v1+json');
		expect(JSON.stringify(r.calls.map((c) => c.query))).not.toContain(TOKEN);
	});

	it('resyncs from the cursor and writes nothing when nothing changed', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		const file = r.app.vault.getFileByPath('Annotation Inbox/Example Post.md');
		const spy = vi.spyOn(r.app.vault, 'process');
		const again = await r.svc.run();
		expect(again).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 1 });
		expect(spy).not.toHaveBeenCalled();
		expect(file).not.toBeNull();
		const second = new URLSearchParams(r.calls[1]?.query);
		expect(second.get('search_after')).toBe('2026-10-01T08:00:29.000000+00:00');
	});

	it('merges a new annotation into the existing note and keeps text outside the markers', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		const path = 'Annotation Inbox/Example Post.md';
		const mine = (await read(r, path)) + '\nMy own notes below.\n';
		await r.app.vault.adapter.write(path, mine);
		r.script.rows.push(row('CCCC3333', 5, { tags: ['Reading List'] }));
		const res = await r.svc.run();
		expect(res).toMatchObject({ ok: true, created: 0, updated: 1 });
		const text = await read(r, path);
		expect(text).toContain('My own notes below.');
		expect(text.indexOf('ai:AAAA1111')).toBeLessThan(text.indexOf('ai:CCCC3333'));
		expect(text).toContain('#Reading-List');
	});

	it('does not make a note again that you deleted', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		const f = r.app.vault.getFileByPath('Annotation Inbox/Example Post.md');
		await r.app.vault.delete(f as never);
		r.svc.noteDeleted('Annotation Inbox/Example Post.md');
		r.script.rows.push(row('CCCC3333', 5));
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, forgotten: 1 });
		expect(r.app.vault.getFileByPath('Annotation Inbox/Example Post.md')).toBeNull();
		expect(r.svc.state.deleted).toEqual(['https://example.com/post']);
	});

	it('remembers a note that was deleted while the app was closed', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		await r.app.vault.delete(r.app.vault.getFileByPath('Annotation Inbox/Example Post.md') as never);
		r.script.rows.push(row('CCCC3333', 5));
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, forgotten: 1 });
	});

	it('makes the note again after you forget the deleted notes', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		await r.app.vault.delete(r.app.vault.getFileByPath('Annotation Inbox/Example Post.md') as never);
		r.svc.noteDeleted('Annotation Inbox/Example Post.md');
		expect(r.svc.forgetDeleted()).toBe(1);
		r.script.rows.push(row('CCCC3333', 5));
		const res = await r.svc.run();
		expect(res.created).toBe(1);
	});

	it('follows a renamed note', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		const f = r.app.vault.getFileByPath('Annotation Inbox/Example Post.md');
		await r.app.fileManager.renameFile(f as never, 'Elsewhere.md');
		r.svc.noteRenamed('Annotation Inbox/Example Post.md', 'Elsewhere.md');
		r.script.rows.push(row('CCCC3333', 5));
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, updated: 1 });
		expect(await read(r, 'Elsewhere.md')).toContain('ai:CCCC3333');
	});

	it('makes a nested folder, or no folder for the vault root', async () => {
		const r = rig([row('AAAA1111', 1), row('BBBB2222', 2, { uri: 'https://other.org/x', document: { title: ['Other'] } })]);
		r.opts.folder = 'Reading/Hypothesis';
		await r.svc.run();
		expect(r.app.vault.getFileByPath('Reading/Hypothesis/Example Post.md')).not.toBeNull();
		const root = rig([row('AAAA1111', 1)]);
		root.opts.folder = '';
		await root.svc.run();
		expect(root.app.vault.getFileByPath('Example Post.md')).not.toBeNull();
	});

	it('gives two pages with one title two note names', async () => {
		const r = rig([row('AAAA1111', 1), row('BBBB2222', 2, { uri: 'https://other.org/x' })]);
		await r.svc.run();
		expect(r.app.vault.getFileByPath('Annotation Inbox/Example Post.md')).not.toBeNull();
		expect(r.app.vault.getFileByPath('Annotation Inbox/Example Post (2).md')).not.toBeNull();
	});

	it('pages through more than 200 annotations, one request a second', async () => {
		const rows = Array.from({ length: 205 }, (_v, i) => row(`ID${String(i).padStart(5, '0')}`, i, { uri: `https://example.com/p${i % 3}` }));
		const r = rig(rows);
		const res = await r.svc.run();
		expect(res).toMatchObject({ ok: true, fetched: 205, more: false });
		expect(r.calls).toHaveLength(2);
		expect(r.sleeps).toEqual([1000]);
		expect(r.svc.state.cursor).toBe(ts(204));
	});

	it('waits and retries on 429, then gives up after two retries', async () => {
		const r = rig([row('AAAA1111', 1)]);
		r.script.replies.push({ status: 429, json: null, headers: { 'Retry-After': '7' } });
		expect((await r.svc.run()).ok).toBe(true);
		expect(r.sleeps).toEqual([7000]);
		const s = rig([row('AAAA1111', 1)]);
		for (let i = 0; i < 3; i++) s.script.replies.push({ status: 429, json: null, headers: {} });
		const res = await s.svc.run();
		expect(res.ok).toBe(false);
		expect(res.message).toContain('slow down');
		expect(s.svc.state.cursor).toBeNull();
	});

	it('reports a bad token and keeps the cursor', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		const before = r.svc.state.cursor;
		r.script.replies.push({ status: 401, json: { status: 'failure' }, headers: {} });
		const res = await r.svc.run();
		expect(res.ok).toBe(false);
		expect(res.message).toContain('did not accept the token');
		expect(res.message).not.toContain(TOKEN);
		expect(r.svc.state.cursor).toBe(before);
	});

	it('skips replies and hidden annotations and counts them', async () => {
		const r = rig([row('AAAA1111', 1), row('REPLY001', 2, { references: ['AAAA1111'] }), row('HIDDEN01', 3, { hidden: true })]);
		const res = await r.svc.run();
		expect(res).toMatchObject({ fetched: 1, skipped: 2, created: 1 });
	});

	it('starts over when the user changes', async () => {
		const r = rig([row('AAAA1111', 1)]);
		await r.svc.run();
		r.opts.user = 'acct:john@hypothes.is';
		await r.svc.run();
		expect(r.calls[1]?.query).not.toContain('search_after');
		expect(r.svc.state.cursorUser).toBe('acct:john@hypothes.is');
	});

	it('asks for a user name before it sends anything', async () => {
		const r = rig();
		r.opts.user = '';
		const res = await r.svc.run();
		expect(res.ok).toBe(false);
		expect(r.calls).toHaveLength(0);
	});

	it('does not start a second sync while one runs', async () => {
		const r = rig([row('AAAA1111', 1)]);
		const first = r.svc.run();
		const second = await r.svc.run();
		expect(second.message).toContain('already running');
		await first;
	});
});

describe('client and state', () => {
	it('classifies answers', () => {
		const h = {};
		expect(classify({ status: 200, json: { rows: [] }, headers: h })).toMatchObject({ ok: true });
		expect(classify({ status: 0, json: null, headers: h })).toMatchObject({ ok: false, kind: 'offline' });
		expect(classify({ status: 403, json: null, headers: h })).toMatchObject({ kind: 'auth' });
		expect(classify({ status: 429, json: null, headers: { 'retry-after': '3' } })).toMatchObject({ kind: 'rate', waitMs: 3000 });
		expect(classify({ status: 429, json: null, headers: { 'Retry-After': '99999' } })).toMatchObject({ waitMs: 120000 });
		expect(classify({ status: 503, json: null, headers: h })).toMatchObject({ kind: 'server' });
		expect(classify({ status: 418, json: null, headers: h })).toMatchObject({ kind: 'http' });
	});

	it('profile returns the user id, or null when the token is not accepted', async () => {
		const ok = new HypothesisClient({ getToken: () => TOKEN, http: () => Promise.resolve({ status: 200, json: { userid: USER }, headers: {} }) });
		expect(await ok.profile()).toEqual({ ok: true, data: { userid: USER } });
		const anon = new HypothesisClient({ getToken: () => TOKEN, http: () => Promise.resolve({ status: 200, json: { userid: null }, headers: {} }) });
		expect(await anon.profile()).toEqual({ ok: true, data: { userid: null } });
	});

	it('does not send a request without a token', async () => {
		const http = vi.fn<Http>();
		const c = new HypothesisClient({ getToken: () => null, http });
		const r = await c.search(USER, null, 200);
		expect(r).toMatchObject({ ok: false, kind: 'no-token' });
		expect(http).not.toHaveBeenCalled();
	});

	it('rejects an answer without a list of rows', async () => {
		const c = new HypothesisClient({ getToken: () => TOKEN, http: () => Promise.resolve({ status: 200, json: { nope: 1 }, headers: {} }) });
		expect(await c.search(USER, null, 200)).toMatchObject({ ok: false });
	});

	it('repairs bad saved state', () => {
		expect(normalizeState(null)).toEqual(emptyState());
		const s = normalizeState({ cursor: 5, pages: { a: { path: 'x.md' }, b: 3, c: { path: '' } }, deleted: ['k', 'k', 7], lastSync: 'z' });
		expect(s).toEqual({ cursor: null, cursorUser: '', pages: { a: { path: 'x.md' } }, deleted: ['k'], lastSync: 'z' });
	});

	it('writes one sentence for the notice', () => {
		const base = { ok: true, message: '', fetched: 3, skipped: 0, created: 1, updated: 2, unchanged: 0, forgotten: 0, more: false };
		expect(summary(base)).toBe('Imported 3 annotations: 1 new note, 2 updated.');
		expect(summary({ ...base, fetched: 1, forgotten: 1, more: true })).toBe('Imported 1 annotation: 1 new note, 2 updated, 1 skipped because you deleted it. There are more. Run Sync now again.');
	});
});
