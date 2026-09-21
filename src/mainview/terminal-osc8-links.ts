import type { ILink, ILinkProvider } from "ghostty-web";
import { parseDeepLink } from "../shared/deep-link";

/**
 * Clickable OSC 8 hyperlinks (`ESC ] 8 ; params ; URI ST text ESC ] 8 ; ; ST`).
 *
 * ghostty-web's wasm build assigns a `hyperlink_id` to every linked cell (which
 * is what draws the hover underline), but it never exposes the URI back to
 * JavaScript — `getHyperlinkUri()` is a stub returning null, so the built-in
 * OSC8LinkProvider can never produce a clickable link. The URI therefore has
 * to be captured before the bytes reach the terminal: `createOsc8Tracker`
 * parses the PTY write stream for OSC 8 start/end pairs and remembers
 * label → URI, and `createOsc8LinkProvider` finds linked cell ranges by
 * `hyperlink_id` and resolves their visible text through that map.
 *
 * Keys are whitespace-stripped on both sides: wide glyphs occupy two cells
 * (the second reads back as a blank), so the cell-side label carries spaces
 * the stream-side label never saw.
 */

const MAX_LABEL_LENGTH = 2048;
const MAX_OSC_PAYLOAD = 8192;
/** How many neighbouring rows a wrapped link is stitched across, each way. */
const MAX_STITCH_ROWS = 4;

/**
 * Accept only http(s), and only when the string parses as a URL and carries no
 * control characters or whitespace: browsers strip raw newlines while parsing,
 * so "https://ok.dev\n@evil.example" would navigate to evil.example. Anything
 * wider than http(s) is a dead click on desktop anyway — the new-window-open
 * intercept (window-manager.ts) forwards nothing else to openExternal.
 */
export function safeHttpUri(raw: string): string | undefined {
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x20\x7f]/.test(raw)) return undefined;
	try {
		const protocol = new URL(raw).protocol;
		return protocol === "http:" || protocol === "https:" ? raw : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Accept a local-machine file URI (`pathToFileURL` output — Claude Code wraps
 * every file path it prints in one). Same control-character rules as
 * `safeHttpUri`; a host other than "localhost" is a remote (UNC) target and is
 * rejected — the authority form only, `file:////server/share` carries no host
 * and stays a path the backend then refuses for being outside the allowed
 * roots. Activation never opens these as URLs — they are converted back to a
 * path and go through the terminal-path resolve flow, which enforces the
 * allowed-roots policy on the backend.
 */
export function safeFileUri(raw: string): string | undefined {
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x20\x7f]/.test(raw)) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "file:") return undefined;
		return url.host === "" || url.host === "localhost" ? raw : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Accept a `dev3://…` deep link, and only one whose grammar the app actually
 * navigates: the parse decides, so an unknown host is rejected like any other
 * scheme. Activation never leaves the app — it resolves the id against the
 * boards and navigates in-app, which is also why this stays the ONLY non-web
 * scheme allowed here. Anything else (`javascript:`, `vscode:`, `smb:`…) is
 * either a dead click or someone else's handler, so it keeps being refused.
 */
export function safeDeepLinkUri(raw: string): string | undefined {
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x20\x7f]/.test(raw)) return undefined;
	return parseDeepLink(raw) ? raw : undefined;
}

/** A URI an OSC 8 link is allowed to carry: http(s), a local file, or a dev3 deep link. */
export function safeOsc8Uri(raw: string): string | undefined {
	return safeHttpUri(raw) ?? safeFileUri(raw) ?? safeDeepLinkUri(raw);
}

// file.ts:12 or file.ts:12:5 baked into the URI path — same convention the
// file-path link provider strips before stat(). Bounded: an editor has no use
// for a line number wider than the digits any real file could carry.
const FILE_URI_LINE_SUFFIX = /:(\d{1,9})(?::\d+)?$/;

/**
 * Convert a `file://` URI back to a local filesystem path, with an optional
 * trailing :line[:col] carried out separately. Returns undefined for anything
 * `safeFileUri` rejects or a path that fails percent-decoding.
 */
export function fileUriToLocalPath(uri: string): { path: string; line?: number } | undefined {
	if (!safeFileUri(uri)) return undefined;
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(uri).pathname);
	} catch {
		return undefined;
	}
	// Decoding re-introduces what safeFileUri rejected in the raw URI: "%00"
	// and "%0A" pass the check above and come back out as a NUL or a newline.
	// A space is legitimate here, so this is the tighter set, not the same one.
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f]/.test(pathname)) return undefined;
	// pathToFileURL on Windows yields "/C:/dir/file"; the leading slash is not
	// part of the path there.
	const path = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
	const suffix = FILE_URI_LINE_SUFFIX.exec(path);
	if (!suffix) return { path };
	return { path: path.slice(0, path.length - suffix[0].length), line: Number.parseInt(suffix[1]!, 10) };
}

export interface Osc8Tracker {
	/** Parse one PTY chunk. Chunking is safe — parser state carries across calls. */
	feed(chunk: string): void;
	/**
	 * URI last seen for this visible label (whitespace-insensitive). A label
	 * ever seen with two DIFFERENT URIs is ambiguous and resolves to nothing:
	 * terminal content is untrusted, so a later line re-using an earlier
	 * label must kill that label's mapping, never retarget it.
	 */
	uriFor(label: string): string | undefined;
	dispose(): void;
}

function labelKey(label: string): string {
	return label.replace(/\s+/g, "");
}

const enum ParserState {
	Ground,
	Escape,
	Csi,
	OscPayload,
	/** Non-OSC string sequence (DCS/SOS/PM/APC) — consumed, payload ignored. */
	OtherString,
	/** Saw ESC inside a string sequence — next `\` is the ST terminator. */
	StringEscape,
}

export function createOsc8Tracker(maxEntries = 500): Osc8Tracker {
	// null marks a poisoned key: the label was seen with two different URIs.
	const uris = new Map<string, string | null>();
	let state = ParserState.Ground;
	/** State to resume after a string sequence terminates. */
	let stringKind = ParserState.OtherString;
	let payload = "";
	let csi = "";
	let currentUri: string | null = null;
	let label = "";

	function remember(): void {
		if (currentUri !== null) {
			const key = labelKey(label);
			if (key && key.length <= MAX_LABEL_LENGTH) {
				const existing = uris.get(key);
				const value = existing === undefined || existing === currentUri ? currentUri : null;
				// Re-insert so the Map's insertion order doubles as an LRU.
				uris.delete(key);
				uris.set(key, value);
				if (uris.size > maxEntries) {
					const oldest = uris.keys().next().value;
					if (oldest !== undefined) uris.delete(oldest);
				}
			}
		}
		currentUri = null;
		label = "";
	}

	/** RIS / scrollback erase: whatever the labels named is gone from view. */
	function forgetAll(): void {
		uris.clear();
		currentUri = null;
		label = "";
	}

	function handleOscPayload(): void {
		if (!payload.startsWith("8;")) return;
		// "8;params;URI" — params (e.g. id=…) end at the next semicolon.
		const uriStart = payload.indexOf(";", 2);
		if (uriStart < 0) return;
		const uri = payload.slice(uriStart + 1);
		remember();
		if (uri.length > 0) {
			currentUri = uri;
			label = "";
		}
	}

	function feed(chunk: string): void {
		for (let i = 0; i < chunk.length; i++) {
			const ch = chunk[i];
			const code = chunk.charCodeAt(i);
			switch (state) {
				case ParserState.Ground:
					if (code === 0x1b) state = ParserState.Escape;
					else if (currentUri !== null && code >= 0x20 && code !== 0x7f && label.length < MAX_LABEL_LENGTH) {
						label += ch;
					}
					break;
				case ParserState.Escape:
					if (ch === "]") {
						state = ParserState.OscPayload;
						stringKind = ParserState.OscPayload;
						payload = "";
					} else if (ch === "[") {
						state = ParserState.Csi;
						csi = "";
					} else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") {
						state = ParserState.OtherString;
						stringKind = ParserState.OtherString;
					} else {
						// RIS (ESC c) resets the whole terminal, scrollback included.
						if (ch === "c") forgetAll();
						state = ParserState.Ground;
					}
					break;
				case ParserState.Csi:
					// Parameter/intermediate bytes are 0x20–0x3f; a final byte ends it.
					if (code >= 0x40 && code <= 0x7e) {
						// ED 3 (CSI 3J / CSI ?3J) erases scrollback — drop the map with
						// it. Plain 2J keeps scrollback, so its links stay resolvable.
						if (ch === "J" && csi.replace(/^\?/, "") === "3") forgetAll();
						state = ParserState.Ground;
					} else if (csi.length < 16) {
						csi += ch;
					}
					break;
				case ParserState.OscPayload:
					if (code === 0x07) {
						handleOscPayload();
						state = ParserState.Ground;
					} else if (code === 0x1b) {
						state = ParserState.StringEscape;
					} else if (payload.length < MAX_OSC_PAYLOAD) {
						payload += ch;
					}
					break;
				case ParserState.OtherString:
					if (code === 0x07) state = ParserState.Ground;
					else if (code === 0x1b) state = ParserState.StringEscape;
					break;
				case ParserState.StringEscape:
					if (ch === "\\") {
						if (stringKind === ParserState.OscPayload) handleOscPayload();
						state = ParserState.Ground;
					} else {
						// Not an ST — the sequence is broken; drop it and re-read the
						// character as if it followed a bare ESC.
						state = ParserState.Escape;
						i--;
					}
					break;
			}
		}
	}

	return {
		feed,
		uriFor(text: string) {
			return uris.get(labelKey(text)) ?? undefined;
		},
		dispose() {
			uris.clear();
			currentUri = null;
			label = "";
		},
	};
}

/** The slice of ghostty-web's buffer-line API the provider reads. */
export interface HyperlinkCell {
	getCode(): number;
	getHyperlinkId(): number;
}

export interface HyperlinkLine {
	readonly length: number;
	getCell(x: number): HyperlinkCell | undefined;
}

export type HyperlinkLineReader = (y: number) => HyperlinkLine | undefined;

function cellChar(line: HyperlinkLine, x: number): string {
	const code = line.getCell(x)?.getCode() ?? 0;
	return code === 0 || code < 32 || code > 0xffff ? " " : String.fromCodePoint(code);
}

function hyperlinkId(line: HyperlinkLine | undefined, x: number): number {
	return line?.getCell(x)?.getHyperlinkId() ?? 0;
}

/** Text of every cell of `id` at the edge-adjacent end of a neighbouring row. */
function edgeSegmentText(line: HyperlinkLine | undefined, id: number, fromStart: boolean): string | null {
	if (!line || line.length === 0) return null;
	if (fromStart) {
		if (hyperlinkId(line, 0) !== id) return null;
		let x = 0;
		let text = "";
		while (x < line.length && hyperlinkId(line, x) === id) text += cellChar(line, x++);
		return text;
	}
	if (hyperlinkId(line, line.length - 1) !== id) return null;
	let x = line.length - 1;
	while (x >= 0 && hyperlinkId(line, x) === id) x--;
	let text = "";
	for (let c = x + 1; c < line.length; c++) text += cellChar(line, c);
	return text;
}

/** A resolved link on one row, for hover lookups (`linkAt`). */
export interface Osc8RowLink {
	uri: string;
	x0: number;
	x1: number;
}

export interface Osc8LinkProvider extends ILinkProvider {
	/** The resolved link covering cell (y, x), if any — the hover tooltip's feed. */
	linkAt(y: number, x: number): Osc8RowLink | undefined;
}

export function createOsc8LinkProvider(opts: {
	getLine: HyperlinkLineReader;
	/**
	 * Whether row `y` soft-wraps onto row `y + 1`. `undefined` means unknown
	 * (ghostty-web reports scrollback rows as never wrapped, so a hard `false`
	 * there would kill stitching for every scrolled-out link) — unknown allows
	 * stitching, a definite `false` forbids it.
	 */
	isRowWrapped?: (y: number) => boolean | undefined;
	uriFor: (label: string) => string | undefined;
	/**
	 * The cell a click landed on. ghostty-web caches links by hyperlink id and
	 * gives every OSC 8 link the same id, so the ILink it hands to `activate`
	 * is whichever one was scanned first — see the re-resolve in `activate`.
	 */
	cellFromEvent?: (event: MouseEvent) => { y: number; x: number } | undefined;
	onActivate: (uri: string, event: MouseEvent) => void;
}): Osc8LinkProvider {
	function wrapsToNext(y: number): boolean {
		return opts.isRowWrapped?.(y) !== false;
	}

	/**
	 * A wrapped link continues on neighbouring rows; the tracker recorded the
	 * FULL label, so this row's segment alone would never match. Stitch the
	 * id-contiguous text from adjacent rows (bounded) around this segment —
	 * but only across soft-wrap boundaries: ghostty de-duplicates identical
	 * hyperlinks to one id, so the same link printed on two adjacent rows
	 * shares an id without being one wrapped label.
	 */
	function stitchedLabel(y: number, id: number, segment: string, touchesStart: boolean, touchesEnd: boolean): string {
		let text = segment;
		if (touchesStart) {
			for (let up = 1; up <= MAX_STITCH_ROWS; up++) {
				if (!wrapsToNext(y - up)) break;
				const part = edgeSegmentText(opts.getLine(y - up), id, false);
				if (part === null) break;
				text = part + text;
				if (opts.getLine(y - up)?.getCell(0)?.getHyperlinkId() !== id) break;
			}
		}
		if (touchesEnd) {
			for (let down = 1; down <= MAX_STITCH_ROWS; down++) {
				if (!wrapsToNext(y + down - 1)) break;
				const line = opts.getLine(y + down);
				const part = edgeSegmentText(line, id, true);
				if (part === null) break;
				text += part;
				if (!line || hyperlinkId(line, line.length - 1) !== id) break;
			}
		}
		return text;
	}

	function resolveUri(stitched: string, segment: string): string | undefined {
		// The tracker is the source of truth. Where wrap info is unknown
		// (scrollback) the stitched label may be a false join of two separate
		// links, so the bare segment is tried too — map lookups before the
		// label-is-a-URI fallback, because a false join of two URLs would
		// itself parse as one plausible-looking URL.
		const candidates = segment && segment !== stitched ? [stitched, segment] : [stitched];
		const uri =
			candidates.map((c) => opts.uriFor(c)).find(Boolean) ??
			// A label that IS a URI still works when the tracker missed it
			// (e.g. scrolled past the LRU, or poisoned by a label collision):
			// the visible text itself is the destination, so it cannot lie.
			candidates.map((c) => safeOsc8Uri(c)).find(Boolean);
		return uri !== undefined && safeOsc8Uri(uri) ? uri : undefined;
	}

	function linksForRow(y: number): Osc8RowLink[] {
		const line = opts.getLine(y);
		if (!line || line.length === 0) return [];
		const links: Osc8RowLink[] = [];
		let x = 0;
		while (x < line.length) {
			const id = hyperlinkId(line, x);
			if (id === 0) {
				x++;
				continue;
			}
			const x0 = x;
			let segment = "";
			while (x < line.length && hyperlinkId(line, x) === id) segment += cellChar(line, x++);
			const label = stitchedLabel(y, id, segment, x0 === 0, x === line.length);
			const trimmed = label.trim();
			if (!trimmed) continue;
			const uri = resolveUri(trimmed, segment.trim());
			if (!uri) continue;
			links.push({ uri, x0, x1: x - 1 });
		}
		return links;
	}

	function linkAt(y: number, x: number): Osc8RowLink | undefined {
		try {
			return linksForRow(y).find((link) => x >= link.x0 && x <= link.x1);
		} catch {
			return undefined;
		}
	}

	return {
		provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
			try {
				const links = linksForRow(y).map(
					({ uri, x0, x1 }): ILink => ({
						text: uri,
						// One ILink per row segment, same as the file-path provider:
						// ghostty hit-tests a multi-row range as whole rows.
						range: { start: { x: x0, y }, end: { x: x1, y } },
						activate: (event: MouseEvent) => {
							if (!(event.ctrlKey || event.metaKey)) return;
							// This closure may belong to a different link: ghostty-web
							// keys its link cache by hyperlink id, every OSC 8 link on
							// screen carries the same id, and the cache is answered
							// before the clicked row is scanned. So the cell under the
							// cursor decides, not this row's capture.
							const cell = opts.cellFromEvent?.(event);
							const hit = cell ? linkAt(cell.y, cell.x) : undefined;
							opts.onActivate(hit?.uri ?? uri, event);
						},
					}),
				);
				callback(links.length > 0 ? links : undefined);
			} catch {
				callback(undefined);
			}
		},
		linkAt,
	};
}
