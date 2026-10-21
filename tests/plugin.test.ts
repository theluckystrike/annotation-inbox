import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import AnnotationInboxPlugin from '../src/main';
import { DEFAULT_SETTINGS, DEFAULT_SECRET_ID, AnnotationInboxSettingTab, normalizeSettings } from '../src/settings';
import { isPro, onProChange, bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';

async function load(): Promise<AnnotationInboxPlugin> {
	const app = App.createConfigured__({ files: {} });
	const plugin = new AnnotationInboxPlugin(app as never, manifest as never);
	await plugin.onload();
	return plugin;
}

describe('AnnotationInboxPlugin', () => {
	it('loads with default settings and no Pro manager', async () => {
		const plugin = await load();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(plugin.pro).toBeNull();
		expect(plugin.service.state.cursor).toBeNull();
	});

	it('remembers a note that you delete in the vault', async () => {
		const plugin = await load();
		plugin.service.deps.client.deps.http = () =>
			Promise.resolve({
				status: 200,
				json: { rows: [{ id: 'AAAA1111', created: '2026-10-01T08:00:00+00:00', updated: '2026-10-01T08:00:00+00:00', uri: 'https://example.com/a', text: 'hi', document: { title: ['A'] } }] },
				headers: {},
			});
		plugin.settings = normalizeSettings({ ...plugin.settings, username: 'jane' });
		plugin.app.secretStorage.setSecret(DEFAULT_SECRET_ID, TOKEN);
		const res = await plugin.service.run();
		expect(res.created).toBe(1);
		const f = plugin.app.vault.getFileByPath('Annotation Inbox/A.md');
		expect(f).not.toBeNull();
		await plugin.app.vault.delete(f as never);
		expect(plugin.service.state.deleted).toEqual(['https://example.com/a']);
	});

	it('syncNow runs a sync and shows the result', async () => {
		const plugin = await load();
		plugin.service.deps.client.deps.http = () => Promise.resolve({ status: 200, json: { rows: [] }, headers: {} });
		plugin.settings = normalizeSettings({ ...plugin.settings, username: 'jane' });
		plugin.app.secretStorage.setSecret(DEFAULT_SECRET_ID, TOKEN);
		await plugin.syncNow();
		expect(plugin.service.state.lastSync).not.toBeNull();
		expect(plugin.service.running).toBe(false);
	});

	it('check connection fills in an empty user name from the token', async () => {
		const plugin = await load();
		plugin.app.secretStorage.setSecret(DEFAULT_SECRET_ID, TOKEN);
		plugin.service.deps.client.deps.http = () => Promise.resolve({ status: 200, json: { userid: 'acct:jane@hypothes.is' }, headers: {} });
		await plugin.checkConnection();
		expect(plugin.settings.username).toBe('jane');
	});

	it('lists its settings and never names Pro in the free build', async () => {
		const plugin = await load();
		const tab = new AnnotationInboxSettingTab(plugin.app as never, plugin);
		const defs = tab.getSettingDefinitions();
		const names = defs.map((d) => ('name' in d ? d.name : ''));
		expect(names).toEqual(['Hypothesis developer token', 'Hypothesis user name', 'Check connection', 'Folder', 'File name', 'Note properties', 'Sync now', 'Forget deleted notes', 'Status', '']);
		// The last item is the "More from NoteMods" group of packages/hello, which has a heading and no name.
		expect(defs.at(-1)).toMatchObject({ type: 'group', heading: 'More from NoteMods' });
		expect(JSON.stringify(defs)).not.toMatch(/\bPro\b|Sponsor/);
	});
});

const TOKEN = 'secret-token-123';

describe('settings', () => {
	it('repairs bad saved settings', () => {
		expect(normalizeSettings({ tokenSecretId: 'Bad Id!', username: 5 as never, folder: 7 as never, template: '' })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});

	it('cleans the note properties and keeps them empty by default', () => {
		expect(DEFAULT_SETTINGS.properties).toBe('');
		expect(normalizeSettings({ properties: 'created: {created}\r\nno colon\nbad name: x\n status : unread ' }).properties).toBe('created: {created}\nstatus: unread');
		expect(normalizeSettings({ properties: 5 as never }).properties).toBe('');
	});

	it('shows the note properties as a text area that saves into the settings', async () => {
		const plugin = await load();
		const tab = new AnnotationInboxSettingTab(plugin.app as never, plugin);
		const item = tab.getSettingDefinitions().find((d) => 'name' in d && d.name === 'Note properties');
		expect(item && 'control' in item ? item.control : null).toMatchObject({ type: 'textarea', key: 'properties' });
		await tab.setControlValue('properties', 'status: unread\nnot a line');
		expect(plugin.settings.properties).toBe('status: unread');
	});

	it('keeps an empty folder as the vault root and cleans a folder path', () => {
		expect(normalizeSettings({ folder: '' }).folder).toBe('');
		expect(normalizeSettings({ folder: '/a/../b/' }).folder).toBe('a/b');
	});
});

describe('Pro facade in the free build', () => {
	it('is off for everybody, binds nothing and keeps the listener API', () => {
		expect(isPro()).toBe(false);
		const cb = vi.fn();
		const off = onProChange(cb);
		const manager = { isPro: () => true, onChange: vi.fn(() => () => undefined) };
		bindPro(manager as never);
		expect(manager.onChange).not.toHaveBeenCalled();
		expect(isPro()).toBe(false);
		off();
		resetPro();
		expect(cb).not.toHaveBeenCalled();
	});
});
