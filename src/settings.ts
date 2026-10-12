/* global __PRO_BUILD__ -- esbuild defines this build flag (src/flags.d.ts) */
import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { DEFAULT_FOLDER, DEFAULT_PROPERTIES, DEFAULT_TEMPLATE, normalizeFolder, normalizeProperties, normalizeTemplate, normalizeUser, renderFileName } from './logic';
import { PRO_UI } from './pro';
import type AnnotationInboxPlugin from './main';

export interface AnnotationInboxSettings {
	/** Name of the secret in Obsidian secret storage. The token itself is never in data.json. */
	tokenSecretId: string;
	/** Hypothesis user name, as typed. */
	username: string;
	folder: string;
	template: string;
	/** Extra front matter lines for new notes, one "name: value" for each line. Empty means the four standard properties only. */
	properties: string;
}

export const DEFAULT_SECRET_ID = 'annotation-inbox-hypothesis-token';

export const DEFAULT_SETTINGS: AnnotationInboxSettings = {
	tokenSecretId: DEFAULT_SECRET_ID,
	username: '',
	folder: DEFAULT_FOLDER,
	template: DEFAULT_TEMPLATE,
	properties: DEFAULT_PROPERTIES,
};

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<AnnotationInboxSettings> | null | undefined): AnnotationInboxSettings {
	const s = saved ?? {};
	const id = typeof s.tokenSecretId === 'string' && /^[a-z0-9-]+$/.test(s.tokenSecretId) ? s.tokenSecretId : DEFAULT_SETTINGS.tokenSecretId;
	return {
		tokenSecretId: id,
		username: typeof s.username === 'string' ? s.username.trim().slice(0, 80) : '',
		// An empty folder is the vault root. A missing value is the default folder.
		folder: typeof s.folder === 'string' ? normalizeFolder(s.folder) : DEFAULT_SETTINGS.folder,
		template: typeof s.template === 'string' ? normalizeTemplate(s.template) : DEFAULT_SETTINGS.template,
		properties: typeof s.properties === 'string' ? normalizeProperties(s.properties) : DEFAULT_SETTINGS.properties,
	};
}

const SAMPLE = { key: 'example.com/post', uri: 'example.com/post', title: 'How to read a paper', firstCreated: '2026-10-11T02:28:04+00:00' };

export class AnnotationInboxSettingTab extends PluginSettingTab {
	plugin: AnnotationInboxPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: AnnotationInboxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		this.plugin.settings = normalizeSettings({ ...this.plugin.settings, [key]: value });
		await this.plugin.persist();
	}

	private statusText(): string {
		const st = this.plugin.service.state;
		const last = st.lastSync === null ? 'never' : st.lastSync.replace('T', ' ').slice(0, 19) + ' UTC';
		const notes = Object.keys(st.pages).length;
		return `Last sync: ${last}. Notes made by the plugin: ${notes}. Deleted notes that are not made again: ${st.deleted.length}.`;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const example = renderFileName(this.plugin.settings.template, SAMPLE);
		return [
			...(__PRO_BUILD__ && this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
			{
				name: 'Hypothesis developer token',
				desc: 'Make a token on hypothes.is/account/developer. It is kept in Obsidian secret storage, not in a note or in data.json. It is sent to api.hypothes.is, and to no other host.',
				control: { type: 'secret', key: 'tokenSecretId', defaultValue: DEFAULT_SECRET_ID },
			},
			{
				name: 'Hypothesis user name',
				desc: 'Your account name, for example "jane" for acct:jane@hypothes.is. Check connection fills it in from your token.',
				control: {
					type: 'text',
					key: 'username',
					defaultValue: '',
					placeholder: 'jane',
					validate: (v: string) => (v.trim() === '' || normalizeUser(v) !== '' ? undefined : 'Use 3 to 30 letters, digits, dots or underscores.'),
				},
			},
			{
				name: 'Check connection',
				desc: 'Asks Hypothesis who owns the token. This sends 1 request.',
				action: () => void this.plugin.checkConnection().then(() => this.update()),
			},
			{
				name: 'Folder',
				desc: 'The folder for the imported notes. It is made when needed. Leave it empty for the vault root.',
				control: { type: 'text', key: 'folder', defaultValue: DEFAULT_FOLDER, placeholder: DEFAULT_FOLDER },
			},
			{
				name: 'File name',
				desc: `Template for the note name. Tokens: {title}, {domain}, {date} (first annotation) and {id} (short hash of the address). Now: "${example}". A note name is fixed when the note is made.`,
				control: { type: 'text', key: 'template', defaultValue: DEFAULT_TEMPLATE, placeholder: DEFAULT_TEMPLATE },
			},
			{
				name: 'Note properties',
				desc: 'Extra properties for new notes, one "name: value" for each line. Tokens: {title}, {url}, {domain}, {created} (day of the first annotation) and {created:FORMAT} with YYYY, YY, MM, DD, HH, mm and ss, in UTC. A "tags" line adds tags. Existing notes are not changed.',
				control: { type: 'textarea', key: 'properties', defaultValue: DEFAULT_PROPERTIES, placeholder: 'created: {created}\ntags: article, inbox\nstatus: unread', rows: 4 },
			},
			{
				name: 'Sync now',
				desc: 'Gets new and changed annotations. Up to 10,000 in one run; run it again for more.',
				action: () => void this.plugin.syncNow().then(() => this.update()),
			},
			{
				name: 'Forget deleted notes',
				desc: 'The plugin does not make a note again that you deleted. This clears that list, so the next sync can make those notes again. It does not change the sync cursor.',
				action: () => this.plugin.forgetDeleted(),
			},
			{ name: 'Status', desc: this.statusText() },
		];
	}
}
