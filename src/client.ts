// Hypothesis API v1 client over Obsidian requestUrl (no Node, works on phone and tablet).
// Two requests exist: GET /api/profile (who owns the token) and GET /api/search (your annotations, read only).
// The token is read from SecretStorage for each request. It is never stored here, logged or put in an error text.
import { requestUrl } from 'obsidian';
import { searchQuery } from './logic';

export interface HttpRequest {
	kind: 'profile' | 'search';
	/** Query string of a search request, without the "?". */
	query: string;
	headers: Record<string, string>;
}
export interface HttpReply {
	status: number;
	json: unknown;
	headers: Record<string, string>;
}
export type Http = (r: HttpRequest) => Promise<HttpReply>;

/**
 * The network call sites of the plugin. The profile URL is a literal. The search URL starts with a literal prefix that
 * ends the host, so the query cannot change the host (tools/network-gate.mjs, product.yaml network_path_hosts).
 * status 0 means no answer: offline.
 */
export const obsidianHttp: Http = async (r) => {
	try {
		const res =
			r.kind === 'profile'
				? await requestUrl({ url: 'https://api.hypothes.is/api/profile', method: 'GET', headers: r.headers, throw: false })
				: await requestUrl({ url: `https://api.hypothes.is/api/search?${r.query}`, method: 'GET', headers: r.headers, throw: false });
		let json: unknown = null;
		try {
			json = res.json;
		} catch {
			json = null;
		}
		return { status: res.status, json, headers: res.headers };
	} catch {
		return { status: 0, json: null, headers: {} };
	}
};

export type FailKind = 'no-token' | 'auth' | 'rate' | 'offline' | 'server' | 'http';
export type Reply<T> = { ok: true; data: T } | { ok: false; kind: FailKind; status: number; waitMs: number; message: string };

export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 120_000;

const fail = (kind: FailKind, status: number, message: string, waitMs = 0): Reply<never> => ({ ok: false, kind, status, waitMs, message });

const header = (h: Record<string, string>, name: string): string | null => {
	const key = Object.keys(h).find((k) => k.toLowerCase() === name);
	return key === undefined ? null : (h[key] ?? null);
};

/** Seconds in a Retry-After header, as ms, or the default. A date form is not used. */
export function waitFrom(h: Record<string, string>): number {
	const v = Number(header(h, 'retry-after'));
	return Number.isFinite(v) && v > 0 ? Math.min(MAX_WAIT_MS, Math.round(v * 1000)) : DEFAULT_WAIT_MS;
}

/** Turns an HTTP answer into a reply. 2xx is data. Any other answer is a failure with a text the user can act on. */
export function classify(r: HttpReply): Reply<unknown> {
	if (r.status >= 200 && r.status < 300) return { ok: true, data: r.json };
	if (r.status === 0) return fail('offline', 0, 'No answer from Hypothesis. Check your connection and try again.');
	if (r.status === 401 || r.status === 403) return fail('auth', r.status, 'Hypothesis did not accept the token. Make a new token on hypothes.is/account/developer and save it in the settings.');
	if (r.status === 429) return fail('rate', 429, 'Hypothesis asked us to slow down.', waitFrom(r.headers));
	if (r.status >= 500) return fail('server', r.status, `Hypothesis had a server error (${r.status}). Try again later.`);
	return fail('http', r.status, `Hypothesis answered with status ${r.status}.`);
}

export interface ClientDeps {
	getToken: () => string | null;
	http: Http;
}

export interface Profile {
	userid: string | null;
}

export interface SearchPage {
	rows: unknown[];
}

export class HypothesisClient {
	deps: ClientDeps;

	constructor(deps: ClientDeps) {
		this.deps = deps;
	}

	private async call(kind: HttpRequest['kind'], query: string): Promise<Reply<unknown>> {
		const token = this.deps.getToken();
		if (!token) return fail('no-token', 0, 'Add your Hypothesis developer token in the plugin settings.');
		const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.hypothesis.v1+json' };
		return classify(await this.deps.http({ kind, query, headers }));
	}

	/** Who owns the token. userid is null when Hypothesis treats the request as not logged in. */
	async profile(): Promise<Reply<Profile>> {
		const r = await this.call('profile', '');
		if (!r.ok) return r;
		const j = r.data;
		const id = typeof j === 'object' && j !== null && 'userid' in j ? j.userid : null;
		return { ok: true, data: { userid: typeof id === 'string' && id !== '' ? id : null } };
	}

	/** One page of your annotations, oldest update first, after the cursor. */
	async search(user: string, after: string | null, limit: number): Promise<Reply<SearchPage>> {
		const r = await this.call('search', searchQuery(user, after, limit));
		if (!r.ok) return r;
		const rows = typeof r.data === 'object' && r.data !== null && 'rows' in r.data ? r.data.rows : null;
		if (!Array.isArray(rows)) return fail('http', 200, 'Hypothesis sent an answer that has no list of annotations.');
		return { ok: true, data: { rows } };
	}
}
