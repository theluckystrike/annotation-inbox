/* global __PRO_BUILD__ -- esbuild defines this build flag (src/flags.d.ts) */
// Pro facade through GitHub Sponsors (packages/license, github.ts), wired as in products/table-rollup.
// This release is FREE ONLY. __PRO_BUILD__ (src/flags.d.ts) is false, so the sign in code is not in main.js, isPro() is false
// for everybody and no Pro feature exists in the bundle. The Pro plan is in BRIEF.md. Hypothesis terms need a written
// agreement before Pro is sold, so the build flag stays off until that agreement exists.
// Every Pro check in the plugin calls isPro(); views redraw through onProChange(). main.ts binds the manager in onload.
import type { SponsorsConfig, SponsorsManager } from './license/index';

export const SPONSORS: SponsorsConfig = {
	// Public client id of the seller's OAuth App (device flow on, no client secret anywhere).
	clientId: 'Ov23lic5UPGPZqhBlBGg',
	sponsorLogin: 'theluckystrike',
	minMonthlyUsd: 5,
	oneTimeUsd: 15,
	// 0 = a one-time sponsorship turns Pro on for life.
	oneTimeMonths: 0,
	// Read-only profile access: the sponsorship tier fields need it. No repository or write access.
	scope: 'read:user',
};

export const PRO_UI = {
	proSummary: 'Pro adds automatic sync, several groups with their own folders and tag filters, reply threads and a daily note log.',
	priceText: 'Sponsor $5 a month, or $15 once. When you have paid $15 in total, Pro stays on.',
};

type Listener = () => void;

let manager: SponsorsManager | null = null;
let unbind: (() => void) | null = null;
const listeners = new Set<Listener>();

/** True when Pro features are on. Always false while __PRO_BUILD__ is false. From the cached GitHub Sponsors answer; never sends a request. */
export function isPro(): boolean {
	return __PRO_BUILD__ && (manager?.isPro() ?? false);
}

/** Calls cb each time the Pro state may have changed. Returns a function that removes the listener. */
export function onProChange(cb: Listener): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** Connects the facade to the plugin's GitHub Sponsors manager. Does nothing while __PRO_BUILD__ is false. */
export function bindPro(pro: SponsorsManager): void {
	if (!__PRO_BUILD__) return;
	unbind?.();
	manager = pro;
	unbind = pro.onChange(() => {
		for (const cb of [...listeners]) cb();
	});
}

/** Disconnects the manager and removes all listeners (plugin unload). */
export function resetPro(): void {
	unbind?.();
	unbind = null;
	manager = null;
	listeners.clear();
}
