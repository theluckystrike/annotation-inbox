// The sync: fetch your annotations from the cursor, group them by page, write one note per page.
// Rules: a note that you deleted is never made again; a block that you edited stays until Hypothesis changes that
// annotation; text outside the two marker comments is never touched; nothing is written when nothing changed.
import { normalizePath, type App, type TFile } from 'obsidian';
import type { HypothesisClient } from './client';
import {
	CURSOR_OVERLAP_MS,
	START_MARK,
	laterOf,
	mergeBody,
	mergeTags,
	normalizeFolder,
	normalizeTemplate,
	pageKey,
	pageTags,
	parseAnnotation,
	renderFileName,
	renderNote,
	rewindCursor,
	uniqueName,
	updatedStamp,
	groupByPage,
	type Annotation,
	type PageGroup,
} from './logic';

export const PAGE_LIMIT = 200;
/** Batches of one run. 50 x 200 = 10,000 annotations. A larger account finishes on the next run. */
export const MAX_BATCHES = 50;
export const MIN_GAP_MS = 1000;
export const MAX_RETRIES = 2;
export const MAX_DELETED = 100_000;

export interface SyncState {
	/** Latest update time that was fetched. The next run starts a little before it. */
	cursor: string | null;
	/** The user the cursor belongs to. A different user starts over. */
	cursorUser: string;
	/** Page key to the note that holds it. */
	pages: Record<string, { path: string }>;
	/** Page keys of notes that you deleted. They are not made again. */
	deleted: string[];
	lastSync: string | null;
}

export const emptyState = (): SyncState => ({ cursor: null, cursorUser: '', pages: {}, deleted: [], lastSync: null });

/** Fills gaps and drops bad values from saved data. */
export function normalizeState(saved: unknown): SyncState {
	const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<Record<keyof SyncState, unknown>>;
	const pages: SyncState['pages'] = {};
	if (typeof s.pages === 'object' && s.pages !== null) {
		for (const [k, v] of Object.entries(s.pages as Record<string, unknown>)) {
			const path = typeof v === 'object' && v !== null ? (v as { path?: unknown }).path : null;
			if (typeof path === 'string' && path !== '') pages[k] = { path };
		}
	}
	const deleted = Array.isArray(s.deleted) ? (s.deleted as unknown[]).filter((d): d is string => typeof d === 'string').slice(-MAX_DELETED) : [];
	return {
		cursor: typeof s.cursor === 'string' && s.cursor !== '' ? s.cursor : null,
		cursorUser: typeof s.cursorUser === 'string' ? s.cursorUser : '',
		pages,
		deleted: [...new Set(deleted)],
		lastSync: typeof s.lastSync === 'string' ? s.lastSync : null,
	};
}

export interface SyncOptions {
	user: string;
	folder: string;
	template: string;
	properties: string;
}

export interface SyncResult {
	ok: boolean;
	message: string;
	fetched: number;
	skipped: number;
	created: number;
	updated: number;
	unchanged: number;
	forgotten: number;
	/** Pages whose note could not be written. The cursor stays, so the next run tries them again. */
	failed: number;
	more: boolean;
}

export interface SyncDeps {
	app: App;
	client: HypothesisClient;
	options: () => SyncOptions;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	save: () => void;
}

interface Fetched {
	anns: Annotation[];
	rows: number;
	skipped: number;
	last: string | null;
	more: boolean;
	error: string | null;
}

const blank = (message: string, ok = false): SyncResult => ({ ok, message, fetched: 0, skipped: 0, created: 0, updated: 0, unchanged: 0, forgotten: 0, failed: 0, more: false });

export class SyncService {
	deps: SyncDeps;
	state: SyncState;
	running = false;

	constructor(deps: SyncDeps, state: SyncState) {
		this.deps = deps;
		this.state = state;
	}

	/** A note of ours was deleted: remember the page so that it is not made again. */
	noteDeleted(path: string): void {
		for (const [key, rec] of Object.entries(this.state.pages)) {
			if (rec.path !== path && !rec.path.startsWith(`${path}/`)) continue;
			delete this.state.pages[key];
			if (!this.state.deleted.includes(key)) this.state.deleted.push(key);
		}
		this.deps.save();
	}

	/** A note or a folder of ours moved: follow it. */
	noteRenamed(oldPath: string, newPath: string): void {
		for (const rec of Object.values(this.state.pages)) {
			if (rec.path === oldPath) rec.path = newPath;
			else if (rec.path.startsWith(`${oldPath}/`)) rec.path = `${newPath}${rec.path.slice(oldPath.length)}`;
		}
		this.deps.save();
	}

	/** Makes the plugin forget which notes you deleted. The next sync can make them again. */
	forgetDeleted(): number {
		const n = this.state.deleted.length;
		this.state.deleted = [];
		this.deps.save();
		return n;
	}

	private async fetchAll(user: string, from: string | null): Promise<Fetched> {
		const out: Fetched = { anns: [], rows: 0, skipped: 0, last: null, more: false, error: null };
		let after = from;
		for (let i = 0; i < MAX_BATCHES; i++) {
			if (i > 0) await this.deps.sleep(MIN_GAP_MS);
			const r = await this.searchWithRetry(user, after);
			if (!r.ok) {
				out.error = r.message;
				return out;
			}
			for (const row of r.rows) this.take(row, out);
			const last = lastUpdated(r.rows);
			out.more = r.rows.length >= PAGE_LIMIT && last !== null && last !== after;
			if (last !== null) after = last;
			if (!out.more) return out;
		}
		return out;
	}

	private take(row: unknown, out: Fetched): void {
		out.rows++;
		const a = parseAnnotation(row);
		if (a === null) out.skipped++;
		else out.anns.push(a);
		const u = typeof row === 'object' && row !== null ? (row as { updated?: unknown }).updated : null;
		if (typeof u === 'string' && u !== '') out.last = laterOf(out.last, u);
	}

	private async searchWithRetry(user: string, after: string | null): Promise<{ ok: true; rows: unknown[] } | { ok: false; message: string }> {
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const r = await this.deps.client.search(user, after, PAGE_LIMIT);
			if (r.ok) return { ok: true, rows: r.data.rows };
			if (r.kind !== 'rate' || attempt === MAX_RETRIES) return { ok: false, message: r.message };
			await this.deps.sleep(r.waitMs);
		}
		return { ok: false, message: 'Hypothesis asked us to slow down. Try again later.' };
	}

	/** Runs one sync. Never throws: a failure comes back in the result and the cursor stays where the last full batch ended. */
	async run(): Promise<SyncResult> {
		if (this.running) return blank('A sync is already running.');
		const opt = this.deps.options();
		if (opt.user === '') return blank('Add your Hypothesis user name in the plugin settings.');
		this.running = true;
		try {
			return await this.runInner(opt);
		} catch (e) {
			return blank(`Sync stopped: ${e instanceof Error ? e.message : 'unknown error'}.`);
		} finally {
			this.running = false;
		}
	}

	private async runInner(opt: SyncOptions): Promise<SyncResult> {
		if (this.state.cursorUser !== opt.user) {
			this.state.cursor = null;
			this.state.cursorUser = opt.user;
		}
		const from = this.state.cursor === null ? null : rewindCursor(this.state.cursor, CURSOR_OVERLAP_MS);
		const got = await this.fetchAll(opt.user, from);
		const res = blank('', got.error === null);
		res.fetched = got.anns.length;
		res.skipped = got.skipped;
		res.more = got.more;
		// One note that cannot be written (a bad front matter, a name that is taken) must not stop the other pages.
		let writeError: string | null = null;
		for (const page of groupByPage(got.anns)) {
			try {
				res[await this.applyPage(page, opt)]++;
			} catch (e) {
				res.failed++;
				writeError ??= `Could not write the note for ${page.title}: ${e instanceof Error ? e.message : 'unknown error'}`;
			}
		}
		if (writeError !== null) res.ok = false;
		if (got.last !== null && writeError === null) this.state.cursor = laterOf(this.state.cursor, got.last);
		if (res.ok) this.state.lastSync = new Date(this.deps.now()).toISOString();
		this.deps.save();
		const errors = [got.error, writeError].filter((t): t is string => t !== null);
		res.message = [...errors, summary(res)].join(' ');
		return res;
	}

	private async applyPage(page: PageGroup, opt: SyncOptions): Promise<'created' | 'updated' | 'unchanged' | 'forgotten'> {
		if (this.state.deleted.includes(page.key)) return 'forgotten';
		const rec = this.state.pages[page.key];
		const file = rec ? this.deps.app.vault.getFileByPath(rec.path) : null;
		if (rec && !file) {
			const moved = await this.findByUrl(page.key);
			if (!moved) {
				delete this.state.pages[page.key];
				this.state.deleted.push(page.key);
				return 'forgotten';
			}
			rec.path = moved.path;
			return this.updateNote(moved, page);
		}
		if (file) return this.updateNote(file, page);
		await this.createNote(page, opt);
		return 'created';
	}

	/**
	 * A note of ours whose "url" property is this page, for a note that moved while Obsidian was closed. A note
	 * without the start marker is not ours (a web clipping, for example), so it is not used.
	 */
	private async findByUrl(key: string): Promise<TFile | null> {
		const { vault, metadataCache } = this.deps.app;
		for (const f of vault.getMarkdownFiles()) {
			const url: unknown = metadataCache.getFileCache(f)?.frontmatter?.url;
			if (typeof url === 'string' && pageKey(url) === key && (await vault.cachedRead(f)).includes(START_MARK)) return f;
		}
		return null;
	}

	private async createNote(page: PageGroup, opt: SyncOptions): Promise<void> {
		const { vault } = this.deps.app;
		const folder = normalizeFolder(opt.folder);
		let made = '';
		for (const part of folder === '' ? [] : folder.split('/')) {
			made = made === '' ? part : `${made}/${part}`;
			if (!vault.getFolderByPath(made)) await vault.createFolder(made).catch(() => undefined);
		}
		const base = renderFileName(normalizeTemplate(opt.template), page);
		const name = uniqueName(base, (n) => vault.getAbstractFileByPath(normalizePath(`${folder}/${n}.md`)) !== null, shortHashOf(page));
		const path = normalizePath(`${folder}/${name}.md`);
		await vault.create(path, renderNote(page, opt.properties));
		this.state.pages[page.key] = { path };
	}

	private async updateNote(file: TFile, page: PageGroup): Promise<'updated' | 'unchanged'> {
		const { vault, fileManager } = this.deps.app;
		const cur = await vault.cachedRead(file);
		const merged = mergeBody(cur, page.annotations);
		if (merged.text === cur) return 'unchanged';
		await vault.process(file, (data) => mergeBody(data, page.annotations).text);
		const newest = page.annotations.reduce<string | null>((m, a) => laterOf(m, a.updated), null) ?? '';
		const tags = pageTags(page.annotations);
		await fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const old = typeof fm.updated === 'string' ? fm.updated : '';
			const stamp = updatedStamp(newest);
			if (stamp > old) fm.updated = stamp;
			if (tags.length > 0) fm.tags = mergeTags(fm.tags, tags);
		});
		return 'updated';
	}
}

function shortHashOf(page: PageGroup): string {
	return renderFileName('{id}', page);
}

function lastUpdated(rows: unknown[]): string | null {
	const row: unknown = rows[rows.length - 1];
	const u = typeof row === 'object' && row !== null ? (row as { updated?: unknown }).updated : null;
	return typeof u === 'string' && u !== '' ? u : null;
}

/** One sentence for the notice after a sync. */
export function summary(r: SyncResult): string {
	const parts = [`${r.created} new ${r.created === 1 ? 'note' : 'notes'}`, `${r.updated} updated`];
	if (r.failed > 0) parts.push(`${r.failed} not written`);
	if (r.forgotten > 0) parts.push(`${r.forgotten} skipped because you deleted ${r.forgotten === 1 ? 'it' : 'them'}`);
	const head = `Imported ${r.fetched} ${r.fetched === 1 ? 'annotation' : 'annotations'}: ${parts.join(', ')}.`;
	return r.more ? `${head} There are more. Run Sync now again.` : head;
}
