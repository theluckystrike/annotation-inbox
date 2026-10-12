// Pure logic of Annotation Inbox: Hypothesis annotation JSON to Markdown, merge into an existing note, file names.
// No Obsidian import and no network call here, so every rule has a golden vector (packages/spec/vectors/annotation-inbox.json).
// Written from the public Hypothesis API v1 reference (raw copies in research/obsidian-run/raw/b1). No code of any other plugin.

export const START_MARK = '<!-- annotation-inbox:start -->';
export const END_MARK = '<!-- annotation-inbox:end -->';
export const NOTES_HEADING = '## Page notes';
export const HIGHLIGHTS_HEADING = '## Highlights';
export const DEFAULT_FOLDER = 'Annotation Inbox';
export const DEFAULT_TEMPLATE = '{title}';
export const DEFAULT_PROPERTIES = '';
export const MAX_NAME = 100;
/** Overlap in ms when a sync starts from the saved cursor, so two annotations with one timestamp cannot be missed. */
export const CURSOR_OVERLAP_MS = 1000;

export interface Annotation {
	id: string;
	created: string;
	updated: string;
	uri: string;
	title: string;
	text: string;
	quote: string;
	tags: string[];
	/** Start offset of the quote in the page text, when Hypothesis gave one. */
	position: number | null;
	link: string;
}

export interface PageGroup {
	key: string;
	uri: string;
	title: string;
	firstCreated: string;
	annotations: Annotation[];
}

export interface Block {
	id: string;
	updated: string;
	kind: 'note' | 'highlight';
	/** The marker line and everything under it, as it stands in the note. */
	text: string;
}

export interface MergeResult {
	text: string;
	added: number;
	updated: number;
	unchanged: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(str).filter((s) => s !== '') : []);
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/;
const ID = /^[A-Za-z0-9_-]{4,64}$/;

function selectorsOf(target: unknown): Obj[] {
	if (!Array.isArray(target)) return [];
	const first: unknown = (target as unknown[])[0];
	if (!isObj(first) || !Array.isArray(first.selector)) return [];
	return (first.selector as unknown[]).filter(isObj);
}

function titleOf(doc: unknown): string {
	if (!isObj(doc)) return '';
	const t = doc.title;
	const s = Array.isArray(t) ? str((t as unknown[])[0]) : str(t);
	return s.replace(/\s+/g, ' ').trim();
}

function linkOf(links: unknown): string {
	if (!isObj(links)) return '';
	const l = str(links.incontext) || str(links.html);
	return /^https:\/\/[^\s<>()]+$/.test(l) ? l : '';
}

/**
 * One annotation from the API as the plugin keeps it, or null for a row that is not an import: a reply, a hidden
 * annotation, or a row without id, uri or a valid updated time.
 */
export function parseAnnotation(raw: unknown): Annotation | null {
	if (!isObj(raw)) return null;
	const id = str(raw.id);
	const updated = str(raw.updated);
	const uri = str(raw.uri).trim();
	if (!ID.test(id) || !STAMP.test(updated) || uri === '') return null;
	if (raw.hidden === true) return null;
	if (Array.isArray(raw.references) && raw.references.length > 0) return null;
	const sel = selectorsOf(raw.target);
	const quoteSel = sel.find((s) => s.type === 'TextQuoteSelector');
	const posSel = sel.find((s) => s.type === 'TextPositionSelector');
	const start = posSel ? posSel.start : null;
	const created = str(raw.created);
	return {
		id,
		created: STAMP.test(created) ? created : updated,
		updated,
		uri,
		title: titleOf(raw.document),
		text: str(raw.text),
		quote: quoteSel ? str(quoteSel.exact) : '',
		tags: strList(raw.tags),
		position: typeof start === 'number' && Number.isFinite(start) && start >= 0 ? start : null,
		link: linkOf(raw.links),
	};
}

// ---------------------------------------------------------------- pages and names

/** Stable identity of a page: scheme and host in lower case, no fragment, no default port, no trailing slash. */
export function pageKey(uri: string): string {
	const u = uri.trim();
	if (!/^https?:\/\//i.test(u)) return u;
	try {
		const url = new URL(u);
		url.hash = '';
		const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '';
		return `${url.protocol}//${url.host}${path}${url.search}`;
	} catch {
		return u;
	}
}

/** Readable title for a page that has none: host and path. */
export function titleFromUri(uri: string): string {
	const u = uri.trim();
	if (!/^https?:\/\//i.test(u)) return u;
	try {
		const url = new URL(u);
		return `${url.host}${url.pathname.replace(/\/+$/, '')}`;
	} catch {
		return u;
	}
}

export function domainOf(uri: string): string {
	const u = uri.trim();
	try {
		return new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`).host.replace(/^www\./, '');
	} catch {
		return '';
	}
}

/** Groups annotations by page, in the order in which each page first appears. Pages with no title get the host and path. */
export function groupByPage(anns: Annotation[]): PageGroup[] {
	const map = new Map<string, PageGroup>();
	for (const a of anns) {
		const key = pageKey(a.uri);
		let g = map.get(key);
		if (!g) {
			g = { key, uri: a.uri, title: '', firstCreated: a.created, annotations: [] };
			map.set(key, g);
		}
		g.annotations.push(a);
		if (g.title === '' && a.title !== '') g.title = a.title;
		if (a.created < g.firstCreated) g.firstCreated = a.created;
	}
	for (const g of map.values()) if (g.title === '') g.title = titleFromUri(g.uri);
	return [...map.values()];
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** A file name that is safe on desktop and phone and cannot break a link: no path characters, no # ^ [ ], no reserved names. */
export function sanitizeFileName(raw: string, max: number = MAX_NAME): string {
	let s = Array.from(raw.normalize('NFC'), (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('');
	s = s.replace(/[:|]/g, ' - ').replace(/[\\/*?"<>#^[\]]/g, ' ');
	s = s.replace(/\s+/g, ' ').replace(/ -(?: -)+ /g, ' - ');
	s = s.replace(/^(?:\s*-\s+)+|(?:\s+-\s*)+$/g, '').replace(/^[\s.]+|[\s.]+$/g, '');
	s = Array.from(s).slice(0, Math.max(1, max)).join('').replace(/[\s.]+$/g, '');
	if (s === '') return 'Untitled';
	return RESERVED.test(s) ? `_${s}` : s;
}

/** FNV-1a of the page key as 8 hex digits: the {id} of a file name template. */
export function shortHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** File name (without folder and extension) for a page from the template tokens {title}, {domain}, {date} and {id}. */
export function renderFileName(template: string, page: { key: string; uri: string; title: string; firstCreated: string }, max: number = MAX_NAME): string {
	const tokens: Record<string, string> = {
		title: page.title,
		domain: domainOf(page.uri),
		date: page.firstCreated.slice(0, 10),
		id: shortHash(page.key),
	};
	const filled = template.replace(/\{([a-z]+)\}/g, (_m, name: string) => tokens[name] ?? '');
	return sanitizeFileName(filled, max);
}

/** The first of base, "base (2)", "base (3)" and so on that is not taken. Stops at 999 and then adds the page hash. */
export function uniqueName(base: string, isTaken: (name: string) => boolean, hash: string): string {
	if (!isTaken(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const name = `${base} (${n})`;
		if (!isTaken(name)) return name;
	}
	return `${base} ${hash}`;
}

/** Folder path with no leading or trailing slash, no "." or ".." part and no character that a folder name cannot hold. */
export function normalizeFolder(raw: string): string {
	return raw
		.replace(/\\/g, '/')
		.split('/')
		.map((p) => p.replace(/[:*?"<>|#^[\]]/g, '').trim())
		.filter((p) => p !== '' && p !== '.' && p !== '..')
		.join('/');
}

export function normalizeTemplate(raw: string): string {
	const t = raw.trim().slice(0, 120);
	return t === '' ? DEFAULT_TEMPLATE : t;
}

/** "name", "@name", "name@hypothes.is" or "acct:name@hypothes.is" to "acct:name@hypothes.is". Empty when it is not a user name. */
export function normalizeUser(raw: string): string {
	let u = raw.trim().replace(/^acct:/i, '').replace(/^@/, '');
	const at = u.indexOf('@');
	if (at >= 0) {
		if (u.slice(at + 1).toLowerCase() !== 'hypothes.is') return '';
		u = u.slice(0, at);
	}
	return /^[A-Za-z0-9._]{3,30}$/.test(u) ? `acct:${u}@hypothes.is` : '';
}

// ---------------------------------------------------------------- search paging

/** Query string of one search request: your annotations, oldest update first, after the cursor. */
export function searchQuery(user: string, searchAfter: string | null, limit: number): string {
	const parts = [`user=${encodeURIComponent(user)}`, 'sort=updated', 'order=asc', `limit=${Math.min(200, Math.max(1, Math.floor(limit)))}`];
	if (searchAfter) parts.push(`search_after=${encodeURIComponent(searchAfter)}`);
	return parts.join('&');
}

/** The cursor moved back by at least ms, in the format of the API. A text that is not a time is returned as it is. */
export function rewindCursor(cursor: string, ms: number): string {
	const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(cursor);
	if (!m) return cursor;
	const t = Date.parse(`${m[1] ?? ''}${m[2] ?? 'Z'}`);
	if (!Number.isFinite(t)) return cursor;
	return `${new Date(t - ms).toISOString().slice(0, 19)}.000000+00:00`;
}

/** The later of two API times (same format, so text order is time order). */
export function laterOf(a: string | null, b: string): string {
	return a === null || b > a ? b : a;
}

/** Front matter time: UTC to the second with a Z. */
export function updatedStamp(iso: string): string {
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)?$/.test(iso)) return `${iso.slice(0, 19)}Z`;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 19)}Z` : iso;
}

// ---------------------------------------------------------------- markdown

/** A tag that Obsidian accepts (letters, digits, _ - /, not all digits). Empty when nothing is left. */
export function tagText(tag: string): string {
	const t = tag.trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_/-]/gu, '').replace(/^[-/]+|[-/]+$/g, '');
	if (t === '') return '';
	return /^\p{N}+$/u.test(t) ? `tag-${t}` : t;
}

/** Each tag once, in order of first use. Obsidian tags do not care about case, so "Read" and "read" are one tag. */
const uniqTags = (list: string[]): string[] => {
	const seen = new Set<string>();
	return list.filter((t) => t !== '' && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
};
/** Tags of a list of annotations as Obsidian tags, each once, in order of first use. */
export function pageTags(anns: Annotation[]): string[] {
	return uniqTags(anns.flatMap((a) => a.tags.map(tagText)));
}

const noComment = (s: string): string => s.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
/**
 * A comment line that is the same as a section heading would end the block in parseRegion, and the next merge would
 * drop the lines under it. A second space after "##" shows the same heading but does not match.
 */
const noHeading = (s: string): string =>
	s
		.split('\n')
		.map((l) => (l.trimEnd() === NOTES_HEADING || l.trimEnd() === HIGHLIGHTS_HEADING ? l.replace(/^## /, '##  ') : l))
		.join('\n');

/** One annotation as a block. The first line is the marker that the next sync uses to find the block again. */
export function renderBlock(a: Annotation): string {
	const lines = [`<!-- ai:${a.id} ${a.updated} -->`];
	if (a.quote.trim() !== '') lines.push(...noComment(a.quote.trim()).split(/\r?\n/).map((l) => `> ${l}`.trimEnd()), '');
	if (a.text.trim() !== '') lines.push(noHeading(noComment(a.text.trim()).replace(/\r\n/g, '\n')), '');
	const tags = uniqTags(a.tags.map(tagText)).map((t) => `#${t}`);
	const foot = [tags.join(' '), a.link === '' ? '' : `[Open on the page](${a.link})`].filter((p) => p !== '');
	if (foot.length > 0) lines.push(foot.join(' · '));
	return lines.join('\n').trimEnd();
}

const MARKER = /^<!-- ai:([A-Za-z0-9_-]+) (\S+) -->$/;

/** The blocks between the two marker comments of a note body, in order. Text that is no block is not part of the result. */
export function parseRegion(body: string): Block[] | null {
	const a = body.indexOf(START_MARK);
	const b = body.indexOf(END_MARK, a + 1);
	if (a < 0 || b < 0) return null;
	const out: Block[] = [];
	let kind: Block['kind'] = 'highlight';
	let cur: { id: string; updated: string; kind: Block['kind']; lines: string[] } | null = null;
	const flush = (): void => {
		if (cur) out.push({ id: cur.id, updated: cur.updated, kind: cur.kind, text: cur.lines.join('\n').trim() });
		cur = null;
	};
	for (const line of body.slice(a + START_MARK.length, b).split('\n')) {
		const m = MARKER.exec(line.trimEnd());
		if (m) {
			flush();
			cur = { id: m[1] ?? '', updated: m[2] ?? '', kind, lines: [line.trimEnd()] };
		} else if (line.trimEnd() === NOTES_HEADING || line.trimEnd() === HIGHLIGHTS_HEADING) {
			flush();
			kind = line.trimEnd() === NOTES_HEADING ? 'note' : 'highlight';
		} else if (cur) cur.lines.push(line.trimEnd());
	}
	flush();
	return out;
}

/** The region text: start marker, the page notes, the highlights, end marker. Empty sections have no heading. */
export function renderRegion(blocks: Block[]): string {
	const parts = [START_MARK];
	const notes = blocks.filter((b) => b.kind === 'note');
	const marks = blocks.filter((b) => b.kind === 'highlight');
	if (notes.length > 0) parts.push(NOTES_HEADING, ...notes.map((b) => b.text));
	if (marks.length > 0) parts.push(HIGHLIGHTS_HEADING, ...marks.map((b) => b.text));
	parts.push(END_MARK);
	return parts.join('\n\n');
}

/** Order for a new note: by place in the page when known, then by creation time. Page notes have no place. */
export function orderForNew(anns: Annotation[]): Annotation[] {
	const pos = (a: Annotation): number => a.position ?? Number.MAX_SAFE_INTEGER;
	return [...anns].sort((x, y) => pos(x) - pos(y) || (x.created < y.created ? -1 : x.created > y.created ? 1 : 0) || (x.id < y.id ? -1 : 1));
}

/**
 * Puts annotations into a note body. A block is found by the id in its marker. It is replaced only when the incoming
 * annotation has a later updated time than the marker, so your edit of a block stays until Hypothesis changes that
 * annotation. New annotations go at the end of their section. Text outside the two markers is never touched.
 */
export function mergeBody(body: string, incoming: Annotation[]): MergeResult {
	const found = parseRegion(body);
	const blocks: Block[] = found ?? [];
	const index = new Map(blocks.map((b, i) => [b.id, i]));
	let added = 0;
	let updated = 0;
	let unchanged = 0;
	for (const a of incoming) {
		const at = index.get(a.id);
		const next: Block = { id: a.id, updated: a.updated, kind: a.quote.trim() === '' ? 'note' : 'highlight', text: renderBlock(a) };
		if (at === undefined) {
			index.set(a.id, blocks.push(next) - 1);
			added++;
		} else if (a.updated > (blocks[at]?.updated ?? '')) {
			blocks[at] = next;
			updated++;
		} else unchanged++;
	}
	const region = renderRegion(blocks);
	if (found === null) return { text: `${body.trimEnd()}${body.trim() === '' ? '' : '\n\n'}${region}\n`, added, updated, unchanged };
	const a = body.indexOf(START_MARK);
	const b = body.indexOf(END_MARK, a + 1) + END_MARK.length;
	return { text: body.slice(0, a) + region + body.slice(b), added, updated, unchanged };
}

const q = (s: string): string => JSON.stringify(s.replace(/[\r\n]+/g, ' '));

// ---------------------------------------------------------------- note properties

export const MAX_PROPERTIES = 20;
export const MAX_PROPERTY_LINE = 200;
/** Properties that the plugin owns. A line that names one of them is ignored, except "tags", which adds tags. */
const OWNED_PROPERTIES = ['url', 'title', 'updated'];
const PROPERTY_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/;

export interface PropertyLine {
	name: string;
	value: string;
}

/** The lines of the properties setting that are "name: value" with a valid name, at most 20, one line each. */
export function parseProperties(raw: string): PropertyLine[] {
	const out: PropertyLine[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const at = line.indexOf(':');
		if (at < 0) continue;
		const name = line.slice(0, at).trim();
		if (!PROPERTY_NAME.test(name)) continue;
		out.push({ name, value: line.slice(at + 1).trim().slice(0, MAX_PROPERTY_LINE) });
		if (out.length >= MAX_PROPERTIES) break;
	}
	return out;
}

/** The setting text with only its valid lines. An empty text means that the notes get the four standard properties only. */
export function normalizeProperties(raw: string): string {
	return parseProperties(raw)
		.map((p) => `${p.name}: ${p.value}`)
		.join('\n');
}

/** A time with the tokens YYYY, YY, MM, DD, HH, mm and ss, in UTC. Other text stays. Empty when the time is not valid. */
export function formatStamp(iso: string, format: string): string {
	const t = Date.parse(iso.replace(/\.\d+/, ''));
	if (!Number.isFinite(t)) return '';
	const d = new Date(t);
	const two = (n: number): string => String(n).padStart(2, '0');
	const parts: Record<string, string> = {
		YYYY: String(d.getUTCFullYear()).padStart(4, '0'),
		YY: String(d.getUTCFullYear() % 100).padStart(2, '0'),
		MM: two(d.getUTCMonth() + 1),
		DD: two(d.getUTCDate()),
		HH: two(d.getUTCHours()),
		mm: two(d.getUTCMinutes()),
		ss: two(d.getUTCSeconds()),
	};
	return format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (m) => parts[m] ?? m);
}

const PAGE_TOKEN = /\{(title|url|domain)\}/;
/** A number is plain only when YAML keeps each digit: no leading zero, no trailing zero after the point, at most 15 digits. */
const PLAIN_VALUE = /^(?:-?(?:0|[1-9]\d{0,14})(?:\.\d*[1-9])?|true|false|\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?)$/;

/** Fills the tokens {title}, {url}, {domain}, {created} and {created:FORMAT}. A token that is not known gives no text. */
export function fillProperty(value: string, page: { uri: string; title: string; firstCreated: string }): string {
	return value.replace(/\{([a-z]+)(?::([^{}]*))?\}/g, (_m, name: string, format?: string) => {
		if (name === 'title') return page.title;
		if (name === 'url') return page.uri;
		if (name === 'domain') return domainOf(page.uri);
		if (name === 'created') return formatStamp(page.firstCreated, (format ?? 'YYYY-MM-DD').slice(0, 40));
		return '';
	});
}

/**
 * The extra front matter lines and the extra tags of a new note, from the properties setting. A value is plain YAML
 * (a date, a number, true or false) only when the setting wrote it without a page token, so a date stays a date
 * property. Any other value is quoted. A "tags" line adds tags. Lines for url, title and updated are ignored, and so
 * is a name that comes a second time.
 */
export function renderProperties(
	raw: string,
	page: { uri: string; title: string; firstCreated: string },
): { lines: string[]; tags: string[] } {
	const lines: string[] = [];
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const p of parseProperties(raw)) {
		const key = p.name.toLowerCase();
		const text = fillProperty(p.value, page).replace(/\s+/g, ' ').trim();
		if (key === 'tags') {
			tags.push(...text.split(/[,\s]+/).map((t) => tagText(t.replace(/^#/, ''))).filter((t) => t !== ''));
			continue;
		}
		if (OWNED_PROPERTIES.includes(key) || seen.has(key)) continue;
		seen.add(key);
		if (text === '') lines.push(`${p.name}:`);
		else lines.push(`${p.name}: ${PLAIN_VALUE.test(text) && !PAGE_TOKEN.test(p.value) ? text : q(text)}`);
	}
	return { lines, tags };
}

/** Front matter of a new note: url, title, tags, updated, then the extra lines. */
export function renderFrontmatter(f: { url: string; title: string; tags: string[]; updated: string; extra?: string[] }): string {
	const tags = f.tags.length === 0 ? ['tags: []'] : ['tags:', ...f.tags.map((t) => `  - ${t}`)];
	return ['---', `url: ${q(f.url)}`, `title: ${q(f.title)}`, ...tags, `updated: ${f.updated}`, ...(f.extra ?? []), '---', ''].join('\n');
}

/** Text of a new note for a page. The properties setting adds front matter lines and tags to new notes only. */
export function renderNote(page: PageGroup, properties = ''): string {
	const anns = orderForNew(page.annotations);
	const updated = anns.reduce<string | null>((m, a) => laterOf(m, a.updated), null) ?? '';
	const extra = renderProperties(properties, page);
	const head = renderFrontmatter({
		url: page.uri,
		title: page.title,
		tags: uniqTags([...pageTags(anns), ...extra.tags]),
		updated: updatedStamp(updated),
		extra: extra.lines,
	});
	const link = page.uri.replace(/ /g, '%20').replace(/>/g, '%3E');
	const title = page.title.replace(/[\r\n]+/g, ' ');
	const base = `# ${title}\n\nSource: <${link}>\n`;
	return `${head}\n${mergeBody(base, anns).text}`;
}

/** Existing tags plus new tags, each once. The existing order stays. Never removes a tag. */
export function mergeTags(existing: unknown, add: string[]): string[] {
	const have = typeof existing === 'string' ? existing.split(/[,\s]+/) : Array.isArray(existing) ? (existing as unknown[]).map(str) : [];
	return uniqTags([...have.map((t) => t.replace(/^#/, '')), ...add]);
}

// ---------------------------------------------------------------- vectors

const run: Record<string, (a: unknown[]) => unknown> = {
	parseAnnotation: (a) => parseAnnotation(a[0]),
	pageKey: (a) => pageKey(a[0] as string),
	titleFromUri: (a) => titleFromUri(a[0] as string),
	sanitizeFileName: (a) => (a.length > 1 ? sanitizeFileName(a[0] as string, a[1] as number) : sanitizeFileName(a[0] as string)),
	renderFileName: (a) => renderFileName(a[0] as string, a[1] as PageGroup),
	shortHash: (a) => shortHash(a[0] as string),
	normalizeFolder: (a) => normalizeFolder(a[0] as string),
	normalizeTemplate: (a) => normalizeTemplate(a[0] as string),
	normalizeUser: (a) => normalizeUser(a[0] as string),
	searchQuery: (a) => searchQuery(a[0] as string, a[1] as string | null, a[2] as number),
	rewindCursor: (a) => rewindCursor(a[0] as string, a[1] as number),
	updatedStamp: (a) => updatedStamp(a[0] as string),
	tagText: (a) => tagText(a[0] as string),
	renderBlock: (a) => renderBlock(a[0] as Annotation),
	groupByPage: (a) => groupByPage(a[0] as Annotation[]).map((g) => ({ key: g.key, title: g.title, count: g.annotations.length })),
	mergeBody: (a) => mergeBody(a[0] as string, a[1] as Annotation[]),
	renderNote: (a) => renderNote(groupByPage(a[0] as Annotation[])[0] as PageGroup, a[1] as string | undefined),
	parseProperties: (a) => parseProperties(a[0] as string),
	normalizeProperties: (a) => normalizeProperties(a[0] as string),
	formatStamp: (a) => formatStamp(a[0] as string, a[1] as string),
	renderProperties: (a) => renderProperties(a[0] as string, a[1] as PageGroup),
	mergeTags: (a) => mergeTags(a[0], a[1] as string[]),
	uniqueName: (a) => {
		const taken = new Set(a[1] as string[]);
		return uniqueName(a[0] as string, (n) => taken.has(n), a[2] as string);
	},
};

/** Runs the function that a golden vector names. args = [fn, args]. */
export function evalVector(fn: string, args: unknown[]): unknown {
	const f = run[fn];
	if (!f) throw new Error(`unknown vector function ${fn}`);
	return f(args);
}
