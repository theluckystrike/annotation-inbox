/* global __PRO_BUILD__ -- esbuild defines this build flag (src/flags.d.ts) */
import { Notice, Plugin } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { HypothesisClient, obsidianHttp } from './client';
import { normalizeUser } from './logic';
import { SPONSORS, bindPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, AnnotationInboxSettingTab, normalizeSettings, type AnnotationInboxSettings } from './settings';
import { SyncService, emptyState, normalizeState } from './sync';

const SAVE_DELAY_MS = 800;
/** How often to ask the Pro state whether a check is due (Pro build only). It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;

export default class AnnotationInboxPlugin extends Plugin {
	settings: AnnotationInboxSettings = { ...DEFAULT_SETTINGS };
	service: SyncService = this.makeService(emptyState());
	/** GitHub Sponsors manager. Stays null in the free build (__PRO_BUILD__ is false). */
	pro: SponsorsManager | null = null;
	private settingTab: AnnotationInboxSettingTab | null = null;
	private saveTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadAll();
		if (__PRO_BUILD__) {
			// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
			const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS);
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
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		void this.saveNow();
		resetPro();
	}

	private makeService(state: ReturnType<typeof emptyState>): SyncService {
		const client = new HypothesisClient({ getToken: () => this.token(), http: obsidianHttp });
		return new SyncService(
			{
				app: this.app,
				client,
				options: () => ({ user: normalizeUser(this.settings.username), folder: this.settings.folder, template: this.settings.template }),
				now: () => Date.now(),
				sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
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
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, SAVE_DELAY_MS);
	}

	private async saveNow(): Promise<void> {
		await this.saveData({ settings: this.settings, state: this.service.state });
	}

	async persist(): Promise<void> {
		await this.saveNow();
	}

	/** One sync with a notice for the result. */
	async syncNow(): Promise<void> {
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
		const r = await this.service.deps.client.profile();
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
