/* global __PRO_BUILD__ -- esbuild defines this build flag (src/flags.d.ts) */
import { Notice, Plugin, type App } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { HypothesisClient, obsidianHttp } from './client';
import { normalizeUser } from './logic';
import { SPONSORS, bindPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, AnnotationInboxSettingTab, normalizeSettings, type AnnotationInboxSettings } from './settings';
import { SyncService, emptyState, normalizeState } from './sync';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

// App-scoped ownership survives module replacement. A new owner must wait for
// the old service and every already-started save, then read the settled store.
const OWNERS = Symbol.for('annotation-inbox.persistence-owners.v1');
interface PersistenceOwner { wait: () => Promise<void> }
type OwnerApp = App & { [OWNERS]?: Map<string, PersistenceOwner | Promise<void>> };
const SAVE_DELAY_MS = 800;
/** How often to ask the Pro state whether a check is due (Pro build only). It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;

export default class AnnotationInboxPlugin extends Plugin {
	settings: AnnotationInboxSettings = { ...DEFAULT_SETTINGS };
	service: SyncService = this.makeService(emptyState());
	/** GitHub Sponsors manager. Stays null in the free build (__PRO_BUILD__ is false). */
	pro: SponsorsManager | null = null;
	private settingTab: AnnotationInboxSettingTab | null = null;
	private disposed = false;
	private saveTimer: number | null = null;
	private loading: Promise<void> = Promise.resolve();
	private saves: Promise<void> = Promise.resolve();
	private loaded = false;
	private retired = false;
	private previousOwner: PersistenceOwner | null = null;
	private retiring: Promise<void> | null = null;
	private stopOwner: () => void = () => undefined;
	private readonly stopped = new Promise<void>((resolve) => { this.stopOwner = resolve; });

	onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		this.service.dispose(); // The placeholder cannot run while asynchronous loading waits.
		const app = this.app as OwnerApp;
		const owners = app[OWNERS] ??= new Map<string, PersistenceOwner | Promise<void>>();
		const previous = owners.get(this.manifest.id);
		// Also honor a healthy owner from the earlier promise-only module schema.
		this.previousOwner = previous instanceof Promise ? { wait: () => previous } : previous ?? null;
		owners.set(this.manifest.id, { wait: () => this.handoff() });
		this.loading = this.initialize().catch((error: unknown) => {
			// A failed enable has no state of its own. Let a later explicit enable
			// reach the predecessor again, even if the host never unloads this one.
			this.stopOwner();
			this.saveFailed(error);
			throw error;
		});
		return this.loading;
	}

	private async initialize(): Promise<void> {
		await this.previousOwner?.wait();
		this.previousOwner = null;
		if (this.disposed) return;
		await this.loadAll();
		this.loaded = true;
		if (this.disposed) { this.service.dispose(); return; }
		if (__PRO_BUILD__) {
			// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
			const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
			pro.init();
			this.pro = pro;
			bindPro(pro);
			this.register(pro.onChange(() => this.settingTab?.update()));
			this.app.workspace.onLayoutReady(() => {
				void pro.refresh();
				this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
			});
		}
		this.settingTab = new AnnotationInboxSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addRibbonIcon('highlighter', 'Annotation inbox: sync now', () => void this.syncNow());
		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow() });
		this.addCommand({ id: 'forget-deleted', name: 'Forget deleted notes', callback: () => this.forgetDeleted() });
		this.registerEvent(this.app.vault.on('delete', (f) => this.service.noteDeleted(f.path)));
		this.registerEvent(this.app.vault.on('rename', (f, old) => this.service.noteRenamed(old, f.path)));
	}

	onunload(): void {
		this.disposed = true;
		this.service.dispose();
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.stopOwner();
		void this.retire().catch((error: unknown) => this.saveFailed(error));
		resetPro();
	}

	private async handoff(): Promise<void> {
		await this.stopped;
		await this.loading.catch(() => undefined);
		if (!this.loaded) {
			// Failed/queued enables must not replace the recoverable state owner
			// with a permanently rejected promise or save their empty placeholder.
			await this.previousOwner?.wait();
			this.previousOwner = null;
			return;
		}
		await this.retire();
	}

	private retire(): Promise<void> {
		if (this.retired) return Promise.resolve();
		if (this.retiring !== null) return this.retiring;
		const attempt = (async () => {
			await this.loading;
			await this.service.whenIdle();
			if (this.loaded) await this.saveNow();
			// Retain this owner and its complete state until storage accepts it.
			this.retired = true;
		})();
		this.retiring = attempt;
		void attempt.then(() => { this.retiring = null; }, () => { this.retiring = null; });
		return attempt;
	}

	private saveFailed(error: unknown): void {
		console.error('Annotation inbox could not save recovery state', error);
		new Notice('Annotation inbox: could not save recovery state. Keep this vault open and check storage before enabling again.', 10000);
	}

	private makeService(state: ReturnType<typeof emptyState>): SyncService {
		const client = new HypothesisClient({ getToken: () => this.token(), http: obsidianHttp });
		return new SyncService(
			{
				app: this.app,
				client,
				options: () => ({ user: normalizeUser(this.settings.username), folder: this.settings.folder, template: this.settings.template, properties: this.settings.properties }),
				now: () => Date.now(),
				sleep: (ms, signal) => new Promise((resolve) => {
					const finish = (): void => { window.clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
					const timer = window.setTimeout(finish, ms);
					if (signal?.aborted) finish();
					else signal?.addEventListener('abort', finish, { once: true });
				}),
				save: () => this.scheduleSave(),
			},
			state,
		);
	}

	/** The token from Obsidian secret storage. It is read for each request and never kept or logged. */
	private token(): string | null {
		try {
			const t = this.app.secretStorage.getSecret(this.settings.tokenSecretId);
			return t && t.trim() ? t.trim() : null;
		} catch {
			return null;
		}
	}

	private async loadAll(): Promise<void> {
		const raw = (await this.loadData()) as { settings?: Partial<AnnotationInboxSettings>; state?: unknown } | null;
		this.settings = normalizeSettings(raw?.settings);
		this.service = this.makeService(normalizeState(raw?.state));
	}

	private scheduleSave(): void {
		// Retirement waits for the final service callback, then saves once. A
		// callback after unload must not start an automatic recovery retry.
		if (this.retired || this.disposed) return;
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow().catch((error: unknown) => this.saveFailed(error));
		}, SAVE_DELAY_MS);
	}

	private saveNow(): Promise<void> {
		if (this.retired || !this.loaded) return this.saves;
		this.saves = this.saves.catch(() => undefined).then(async () => {
			// Snapshot only when the preceding save has settled. Never pass mutable
			// service state to a delayed adapter and never overlap backend saves.
			const snapshot = JSON.parse(JSON.stringify({ settings: this.settings, state: this.service.state })) as unknown;
			await this.saveData(snapshot);
		});
		return this.saves;
	}

	async persist(): Promise<void> {
		await this.loading;
		if (this.disposed) { await this.retire(); return; }
		await this.saveNow();
	}

	/** One sync with a notice for the result. */
	async syncNow(): Promise<void> {
		await this.loading;
		if (this.disposed) return;
		const busy = new Notice('Annotation inbox: syncing...', 0);
		try {
			const r = await this.service.run();
			busy.hide();
			new Notice(`Annotation inbox: ${r.message}`, 8000);
		} finally {
			busy.hide();
			this.settingTab?.update();
		}
	}

	forgetDeleted(): void {
		const n = this.service.forgetDeleted();
		new Notice(`Annotation inbox: forgot ${n} deleted ${n === 1 ? 'note' : 'notes'}.`);
		this.settingTab?.update();
	}

	/** Asks Hypothesis who owns the token. Fills the user name when it is empty. */
	async checkConnection(): Promise<void> {
		await this.loading;
		if (this.disposed) return;
		const r = await this.service.deps.client.profile();
		if (this.disposed) return;
		if (!r.ok) {
			new Notice(`Annotation inbox: ${r.message}`, 8000);
			return;
		}
		const id = r.data.userid;
		if (id === null) {
			new Notice('Annotation inbox: Hypothesis did not accept the token. Make a new one on hypothes.is/account/developer.', 8000);
			return;
		}
		const name = /^acct:([^@]+)@hypothes\.is$/.exec(id)?.[1] ?? '';
		if (name !== '' && this.settings.username.trim() === '') {
			this.settings = normalizeSettings({ ...this.settings, username: name });
			await this.persist();
		}
		new Notice(`Annotation inbox: connected as ${name === '' ? id : name}.`);
	}
}
