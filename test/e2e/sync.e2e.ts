import { readFileSync } from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { lastNotice, pluginId, reloadPlugin } from './load';

// Real-app checks against a STUBBED Hypothesis (docs/sample-notes/stub-hypothesis.js): no real token, no real request.
// The stub has 7 annotations on 3 pages: one page note on page a, one on page c, and 5 highlights.
const STUB = readFileSync('docs/sample-notes/stub-hypothesis.js', 'utf8');
const FOLDER = 'Annotation Inbox';
const NOTE_A = `${FOLDER}/How to read a paper.md`;

interface Call {
	kind: string;
	query: string;
	auth: string;
	accept: string;
}

async function installStub(): Promise<void> {
	await browser.executeObsidian(({ app }, src) => new Function('app', `return ${src}`)(app) as string, STUB);
}

/** Runs js in the app with the plugin as p and the stub as st. Returns the JSON-safe result. */
async function inApp<T>(js: string): Promise<T> {
	return browser.executeObsidian(
		async ({ app }, id, code) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins[id];
			const st = (window as unknown as { __aiStub?: unknown }).__aiStub;
			const fn = new Function('app', 'p', 'st', `return (async () => (${code}))()`) as (a: unknown, b: unknown, c: unknown) => Promise<T>;
			return fn(app, p, st);
		},
		pluginId,
		js,
	);
}

const readNote = (path: string): Promise<string | null> => inApp<string | null>(`(async () => { const f = app.vault.getFileByPath(${JSON.stringify(path)}); return f ? await app.vault.read(f) : null; })()`);
const noteCount = (): Promise<number> => inApp<number>(`app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(${JSON.stringify(`${FOLDER}/`)})).length`);
const syncNow = async (): Promise<void> => {
	await browser.execute(() => document.querySelectorAll('.notice').forEach((n) => n.remove()));
	await browser.executeObsidianCommand(`${pluginId}:sync-now`);
	await browser.waitUntil(async () => /Imported|slow down|accept|Add your/.test(await lastNotice()), { timeout: 15000 });
};

describe(`${pluginId} in the real app`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const s = await reloadPlugin(pluginId);
		expect(s).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('has no Pro manager in the free build', async function () {
		expect(await inApp<boolean>('p.pro === null')).toBe(true);
	});

	it('first sync makes one note per page with front matter and blocks', async function () {
		await installStub();
		await inApp('st.reset()');
		await syncNow();
		expect(await lastNotice()).toContain('Imported 7 annotations: 3 new notes, 0 updated.');
		expect(await noteCount()).toBe(3);
		const a = (await readNote(NOTE_A)) ?? '';
		expect(a).toContain('url: "https://example.org/essays/how-to-read-a-paper"');
		expect(a).toContain('title: "How to read a paper"');
		expect(a).toContain('  - reading');
		expect(a).toContain('  - method');
		expect(a).toContain('updated: 2026-10-01T09:20:00Z');
		expect(a.indexOf('## Page notes')).toBeLessThan(a.indexOf('## Highlights'));
		expect(a.indexOf("The first pass")).toBeLessThan(a.indexOf('Read the abstract'));
		const calls = await inApp<Call[]>('st.calls');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ kind: 'search', auth: 'Bearer stub-token-0000', accept: 'application/vnd.hypothesis.v1+json' });
		expect(calls[0]?.query).toBe('user=acct%3Ajane%40hypothes.is&sort=updated&order=asc&limit=200');
	});

	it('second sync starts from the cursor and changes no file', async function () {
		const before = await inApp<number>(`app.vault.getFileByPath(${JSON.stringify(NOTE_A)}).stat.mtime`);
		await syncNow();
		expect(await lastNotice()).toContain('Imported 1 annotation: 0 new notes, 0 updated.');
		const calls = await inApp<Call[]>('st.calls');
		expect(calls[1]?.query).toContain('search_after=2026-10-03T07%3A39%3A59.000000%2B00%3A00');
		expect(await inApp<number>(`app.vault.getFileByPath(${JSON.stringify(NOTE_A)}).stat.mtime`)).toBe(before);
		expect(await noteCount()).toBe(3);
	});

	it('a new annotation is added to its note and text outside the markers stays', async function () {
		await inApp(`(async () => { const f = app.vault.getFileByPath(${JSON.stringify(NOTE_A)}); await app.vault.process(f, (d) => d + '\\nMy own summary.\\n'); st.addLater(); })()`);
		await syncNow();
		expect(await lastNotice()).toContain('Imported 2 annotations: 0 new notes, 1 updated.');
		const a = (await readNote(NOTE_A)) ?? '';
		expect(a).toContain('Third pass: attempt to virtually re-implement the paper.');
		expect(a).toContain('My own summary.');
		expect(a.match(/<!-- ai:/g)).toHaveLength(4);
		expect(a).toContain('updated: 2026-10-04T08:15:00Z');
	});

	it('a deleted note is not made again, and Forget deleted notes brings it back', async function () {
		await inApp(`(async () => { await app.vault.delete(app.vault.getFileByPath(${JSON.stringify(NOTE_A)})); st.rows.push({ ...st.rows[0], id: 'stub9abcdefgh', updated: '2026-10-05T10:00:00.123456+00:00' }); })()`);
		await syncNow();
		expect(await lastNotice()).toContain('1 skipped because you deleted it');
		expect(await readNote(NOTE_A)).toBeNull();
		await browser.executeObsidianCommand(`${pluginId}:forget-deleted`);
		await browser.waitUntil(async () => (await lastNotice()).includes('forgot 1 deleted note'), { timeout: 5000 });
		await inApp(`(() => { p.service.state.cursor = null; })()`);
		await syncNow();
		expect(await readNote(NOTE_A)).not.toBeNull();
	});

	it('a rejected token gives a clear notice and keeps the cursor', async function () {
		const cursor = await inApp<string | null>('p.service.state.cursor');
		await inApp(`(() => { st.mode = '401'; })()`);
		await syncNow();
		expect(await lastNotice()).toContain('did not accept the token');
		expect(await inApp<string | null>('p.service.state.cursor')).toBe(cursor);
		await inApp(`(() => { st.mode = 'ok'; })()`);
	});

	it('the settings tab shows the token, user name, folder and file name fields', async function () {
		await inApp(`(() => { app.setting.open(); app.setting.openTabById('annotation-inbox'); return 'ok'; })()`);
		const read = (): Promise<string[]> => inApp<string[]>(`Array.from(app.setting.activeTab.containerEl.querySelectorAll('.setting-item-name')).map((e) => e.textContent ?? '')`);
		await browser.waitUntil(async () => (await read()).length >= 8, { timeout: 10000, timeoutMsg: 'the settings tab drew no items' });
		const names = await read();
		for (const want of ['Hypothesis developer token', 'Hypothesis user name', 'Check connection', 'Folder', 'File name', 'Sync now', 'Forget deleted notes', 'Status']) expect(names).toContain(want);
		await inApp(`(() => { app.setting.close(); return 'ok'; })()`);
	});

	it('makes a nested folder from the folder setting', async function () {
		await inApp(`(async () => { await st.reset(); p.settings.folder = 'Reading/Hypothesis'; })()`);
		await syncNow();
		expect(await readNote('Reading/Hypothesis/How to read a paper.md')).toContain('url: "https://example.org/essays/how-to-read-a-paper"');
		await inApp(`(async () => { await st.reset(); p.settings.folder = 'Annotation Inbox'; return 'ok'; })()`);
	});

	it('check connection fills the user name from the token', async function () {
		await inApp(`(() => { p.settings.username = ''; return 'ok'; })()`);
		await inApp('p.checkConnection()');
		expect(await inApp<string>('p.settings.username')).toBe('jane');
		expect((await inApp<Call[]>('st.calls')).some((c) => c.kind === 'profile')).toBe(true);
	});
});
