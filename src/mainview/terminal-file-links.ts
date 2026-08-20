import type { ILink, ILinkProvider, Terminal } from "ghostty-web";
import type { ResolvedTerminalPath } from "../shared/types";

/**
 * Detects file paths mentioned in terminal output (agent messages, build
 * errors, …) and turns the ones that actually exist on disk into
 * Cmd/Ctrl+Click links. Detection is regex-based over the *logical* line
 * (soft-wrapped rows are stitched back together); existence is verified
 * through the `resolveTerminalPaths` RPC so dead-looking tokens never get
 * underlined.
 *
 * Lookups answer SYNCHRONOUSLY from a resolve cache: ghostty's LinkDetector
 * marks a row scanned before awaiting providers, so an async answer loses the
 * first hover/click on a fresh path. Unknown candidates are resolved in a
 * batched background RPC; `onResolutionsChanged` then lets the underline
 * overlay repaint, and the next cache invalidation (every write) lets hover
 * re-scan the row.
 */

export interface PathCandidate {
	/** Exact matched text, including any trailing :line[:col] suffix. */
	raw: string;
	/** Path with the :line[:col] suffix stripped — what gets resolved on disk. */
	cleanPath: string;
	/** 1-based line number from a :line[:col] suffix, if present. */
	line?: number;
	/** Start index in the logical line text. */
	start: number;
	/** Inclusive end index in the logical line text. */
	end: number;
}

// Three alternatives: rooted paths (/, ~/, ./, ../), relative paths with at
// least one slash, and bare filenames with an alphabetic extension. Bare
// words produce false candidates ("e.g") — the on-disk existence check is
// what filters those out, not the regex.
const PATH_CHARS = "\\w.@%+,=-";
const SEGMENT = `[${PATH_CHARS}]+`;
const PATH_REGEX = new RegExp(
	`(?:~|\\.{1,2})?/(?:${SEGMENT}/)*${SEGMENT}/?` +
		`|(?:${SEGMENT}/)+${SEGMENT}/?` +
		`|[\\w@%+-][\\w.@%+-]*\\.[A-Za-z][A-Za-z0-9]{0,9}`,
	"g",
);

// file.ts:12 or file.ts:12:5 — kept in the link text, stripped for stat().
const LINE_COL_SUFFIX = /^:(\d+)(?::\d+)?/;
const TRAILING_PUNCTUATION = /[.,;:!?'"`)\]}>]+$/;
const MIN_CANDIDATE_LEN = 3;

/** Find file-path-looking tokens in one logical line of terminal text. */
export function findPathCandidates(text: string): PathCandidate[] {
	const candidates: PathCandidate[] = [];
	PATH_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PATH_REGEX.exec(text)) !== null) {
		let raw = match[0];
		const before = match.index > 0 ? text[match.index - 1] : "";
		// Skip URL tails: "https://foo.com/bar" would otherwise match at "//foo…".
		if (before === ":" || before === "/") continue;
		const suffix = LINE_COL_SUFFIX.exec(text.slice(match.index + raw.length));
		if (suffix) raw += suffix[0];
		let cleanPath = suffix ? raw.slice(0, raw.length - suffix[0].length) : raw;
		// Trailing sentence punctuation belongs to the prose, not the path.
		const trimmed = cleanPath.replace(TRAILING_PUNCTUATION, "");
		raw = raw.slice(0, raw.length - (cleanPath.length - trimmed.length));
		cleanPath = trimmed;
		if (cleanPath.length < MIN_CANDIDATE_LEN || !/[/\\.]/.test(cleanPath)) continue;
		if (/^[\d.,]+$/.test(cleanPath)) continue;
		candidates.push({
			raw,
			cleanPath,
			line: suffix ? Number.parseInt(suffix[1], 10) : undefined,
			start: match.index,
			end: match.index + raw.length - 1,
		});
	}
	return candidates;
}

/** The slice of IBufferLine the detection code reads. */
export interface CellLine {
	isWrapped: boolean;
	length: number;
	getCell(x: number): { getCode(): number } | undefined;
}

/**
 * Cell-exact row text: exactly ONE UTF-16 unit per cell, so string index ===
 * screen column. ghostty's `translateToString` skips codepoint-0 cells (rows
 * come back shorter than `cols`, shifting every later index), which is why
 * ghostty's own URL provider builds text cell-by-cell too. Blank, control,
 * and astral codepoints (2 UTF-16 units — emoji, rare CJK) all become spaces;
 * none of them are path characters.
 */
export function lineToText(line: CellLine): string {
	const chars: string[] = [];
	for (let x = 0; x < line.length; x++) {
		const code = line.getCell(x)?.getCode() ?? 0;
		chars.push(code === 0 || code < 32 || code > 0xffff ? " " : String.fromCodePoint(code));
	}
	return chars.join("");
}

export interface LogicalLineRow {
	/** Absolute buffer row. */
	y: number;
	/** This row's slice of the logical line (one UTF-16 unit per cell). */
	text: string;
	/** Offset of this row's first char within the logical line text. */
	offset: number;
	/** Screen column of this row's first char (band start). */
	x0: number;
}

export interface LogicalLine {
	text: string;
	rows: LogicalLineRow[];
}

// Bound reassembly work for pathological single logical lines (minified JSON
// etc.) — beyond this the tail rows just don't get links.
const MAX_LOGICAL_ROWS = 40;

export type BufferLineReader = (y: number) => CellLine | undefined;

/**
 * A column range owned by one tmux pane, inclusive on both ends. Rows are
 * stitched per band, never across a pane border.
 */
interface Band {
	left: number;
	right: number;
}

// tmux draws pane borders with box-drawing verticals (UTF-8 mode, which the app
// always runs in). Nothing on either side of one belongs to the same text flow.
const VERTICAL_SEPARATORS = new Set(["│", "┃", "║", "╎", "╏", "┆", "┇", "┊", "┋"]);

// Both sides of a row seam must look like path text before a full row is
// stitched onto the next one without a wrap flag — prose lines end in a space
// or a period, so they stay separate.
const SEAM_CHAR = /[\w.@%+,=/\\~-]/;

const MIN_BAND_WIDTH = 3;

function bandsOf(text: string): Band[] {
	const bands: Band[] = [];
	let left = 0;
	for (let x = 0; x <= text.length; x++) {
		if (x === text.length || VERTICAL_SEPARATORS.has(text[x]!)) {
			if (x - left >= MIN_BAND_WIDTH) bands.push({ left, right: x - 1 });
			left = x + 1;
		}
	}
	return bands;
}

interface RowInfo {
	y: number;
	text: string;
	isWrapped: boolean;
	bands: Band[];
}

/** Per-pass memo so one viewport repaint reads each buffer row exactly once. */
export type RowCache = Map<number, RowInfo | undefined>;

export function createRowCache(): RowCache {
	return new Map();
}

function readRow(getLine: BufferLineReader, y: number, cache: RowCache): RowInfo | undefined {
	const hit = cache.get(y);
	if (hit !== undefined || cache.has(y)) return hit;
	const line = y >= 0 ? getLine(y) : undefined;
	const text = line ? lineToText(line) : "";
	const info = line ? { y, text, isWrapped: line.isWrapped, bands: bandsOf(text) } : undefined;
	cache.set(y, info);
	return info;
}

function hasBand(row: RowInfo, band: Band): boolean {
	return row.bands.some((b) => b.left === band.left && b.right === band.right);
}

/**
 * Does `upper` continue into `lower` inside `band`?
 *
 * The wrap flag is authoritative when it is there, but it is missing for two
 * cases that matter: rows already in ghostty-web's scrollback (its buffer
 * hardcodes `isWrapped: false` for them) and any tmux window with a vertical
 * split, where tmux redraws each pane row by row and the terminal never sees a
 * wrap at all. Those fall back to geometry: the upper row fills the band to its
 * last column and both sides of the seam read as path text.
 */
function continues(upper: RowInfo, lower: RowInfo, band: Band): boolean {
	const fullWidth = band.left === 0 && band.right === upper.text.length - 1;
	if (fullWidth && lower.isWrapped) return true;
	if (!hasBand(upper, band) || !hasBand(lower, band)) return false;
	return SEAM_CHAR.test(upper.text[band.right] ?? "") && SEAM_CHAR.test(lower.text[band.left] ?? "");
}

function buildLogicalLine(getLine: BufferLineReader, row: RowInfo, band: Band, cache: RowCache): LogicalLine {
	let startY = row.y;
	while (startY > 0 && row.y - startY < MAX_LOGICAL_ROWS) {
		const above = readRow(getLine, startY - 1, cache);
		const current = readRow(getLine, startY, cache);
		if (!above || !current || !continues(above, current, band)) break;
		startY--;
	}
	const rows: LogicalLineRow[] = [];
	let text = "";
	for (let rowY = startY; rowY - startY < MAX_LOGICAL_ROWS; rowY++) {
		const current = readRow(getLine, rowY, cache);
		if (!current) break;
		const slice = current.text.slice(band.left, band.right + 1);
		rows.push({ y: rowY, text: slice, offset: text.length, x0: band.left });
		text += slice;
		const next = readRow(getLine, rowY + 1, cache);
		if (!next || !continues(current, next, band)) break;
	}
	return { text, rows };
}

/**
 * Reassemble the text flows that pass through buffer row `y` — one per column
 * band, so a vertically split tmux window yields one logical line per pane.
 * Each row remembers its offset and its start column, so match indices map
 * back to buffer coordinates.
 */
export function getLogicalLines(getLine: BufferLineReader, y: number, cache: RowCache = createRowCache()): LogicalLine[] {
	const row = readRow(getLine, y, cache);
	if (!row) return [];
	return row.bands.map((band) => buildLogicalLine(getLine, row, band, cache)).filter((line) => line.rows.length > 0);
}

export interface BufferRange {
	start: { x: number; y: number };
	end: { x: number; y: number };
}

/**
 * Map an inclusive [start, end] index range in the logical line to ONE range
 * per buffer row it covers. Single-row ranges keep both hover hit-testing and
 * the underline overlay exact: ghostty's `isPositionInLink` treats a multi-row
 * range as spanning whole rows, which in a vertically split window would claim
 * the neighbouring pane's columns too.
 */
export function mapRangeToBuffer(rows: LogicalLineRow[], start: number, end: number): BufferRange[] {
	const segments: BufferRange[] = [];
	for (const row of rows) {
		const rowStart = Math.max(start, row.offset);
		const rowEnd = Math.min(end, row.offset + row.text.length - 1);
		if (rowStart > rowEnd) continue;
		segments.push({
			start: { x: row.x0 + rowStart - row.offset, y: row.y },
			end: { x: row.x0 + rowEnd - row.offset, y: row.y },
		});
	}
	return segments;
}

const RESOLVE_CACHE_TTL_MS = 10_000;
const RESOLVE_CACHE_MAX = 1000;
const RESOLVE_BATCH_MAX = 64; // matches the backend's per-call cap
const RESOLVE_FLUSH_DELAY_MS = 16;

export interface FilePathLinkProviderOptions {
	term: Pick<Terminal, "buffer">;
	resolvePaths: (paths: string[]) => Promise<Record<string, ResolvedTerminalPath | null>>;
	onActivate: (resolved: ResolvedTerminalPath, event: MouseEvent, line?: number) => void;
	/** Fires after a background RPC resolution lands — the underline overlay redraws on it. */
	onResolutionsChanged?: () => void;
}

export interface FilePathLinkProvider extends ILinkProvider {
	/**
	 * Synchronous link ranges for a set of absolute buffer rows (the visible
	 * viewport), from the resolve cache only. Unknown candidates are queued
	 * for one batched background resolve.
	 */
	linksForRows(ys: number[]): BufferRange[];
	dispose(): void;
}

export function createFilePathLinkProvider(options: FilePathLinkProviderOptions): FilePathLinkProvider {
	const cache = new Map<string, { value: ResolvedTerminalPath | null; at: number }>();
	const pending = new Set<string>();
	const inFlight = new Set<string>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	function requestResolve(paths: Iterable<string>): void {
		for (const path of paths) {
			if (!inFlight.has(path)) pending.add(path);
		}
		if (pending.size > 0 && flushTimer === undefined) {
			flushTimer = setTimeout(() => {
				flushTimer = undefined;
				void flushPending();
			}, RESOLVE_FLUSH_DELAY_MS);
		}
	}

	async function flushPending(): Promise<void> {
		while (!disposed && pending.size > 0) {
			const batch = [...pending].slice(0, RESOLVE_BATCH_MAX);
			for (const path of batch) {
				pending.delete(path);
				inFlight.add(path);
			}
			try {
				const resolved = await options.resolvePaths(batch);
				if (cache.size > RESOLVE_CACHE_MAX) cache.clear();
				for (const path of batch) {
					cache.set(path, { value: resolved[path] ?? null, at: Date.now() });
				}
				options.onResolutionsChanged?.();
			} catch {
				// Transport hiccup — candidates stay unresolved and are re-requested
				// on the next hover/redraw.
			} finally {
				for (const path of batch) inFlight.delete(path);
			}
		}
	}

	/**
	 * Cached target for a candidate path. Stale entries are served
	 * stale-while-revalidate; unknown ones queue a background resolve and
	 * report undefined.
	 */
	function cachedTarget(path: string): ResolvedTerminalPath | null | undefined {
		const hit = cache.get(path);
		if (!hit) {
			requestResolve([path]);
			return undefined;
		}
		if (Date.now() - hit.at >= RESOLVE_CACHE_TTL_MS) requestResolve([path]);
		return hit.value;
	}

	interface RowLink {
		target: ResolvedTerminalPath;
		candidate: PathCandidate;
		/** One range per buffer row the candidate covers. */
		segments: BufferRange[];
	}

	function computeLinks(y: number, cache?: RowCache): RowLink[] {
		const logicalLines = getLogicalLines((row) => options.term.buffer.active.getLine(row), y, cache);
		const links: RowLink[] = [];
		for (const logical of logicalLines) {
			for (const candidate of findPathCandidates(logical.text)) {
				const target = cachedTarget(candidate.cleanPath);
				if (!target) continue;
				const segments = mapRangeToBuffer(logical.rows, candidate.start, candidate.end);
				if (segments.length === 0) continue;
				links.push({ target, candidate, segments });
			}
		}
		return links;
	}

	return {
		provideLinks(y, callback) {
			try {
				// One ILink per row segment: ghostty hit-tests a multi-row range as
				// whole rows, which would claim a split window's other pane.
				const links: ILink[] = computeLinks(y).flatMap(({ target, candidate, segments }) =>
					segments.map((range) => ({
						text: candidate.raw,
						range,
						activate: (event: MouseEvent) => {
							if (event.ctrlKey || event.metaKey) options.onActivate(target, event, candidate.line);
						},
					})),
				);
				callback(links.length > 0 ? links : undefined);
			} catch {
				callback(undefined);
			}
		},
		linksForRows(ys) {
			const ranges: BufferRange[] = [];
			// A logical line spans several rows, so a link surfaces once per row it
			// covers; dedupe by range instead of skipping rows, whose other column
			// bands may still hold links of their own.
			const seen = new Set<string>();
			const cache = createRowCache();
			for (const y of ys) {
				try {
					for (const { segments } of computeLinks(y, cache)) {
						for (const range of segments) {
							const key = `${range.start.y}:${range.start.x}:${range.end.x}`;
							if (seen.has(key)) continue;
							seen.add(key);
							ranges.push(range);
						}
					}
				} catch {
					// skip unreadable rows
				}
			}
			return ranges;
		},
		dispose() {
			disposed = true;
			clearTimeout(flushTimer);
			pending.clear();
			cache.clear();
		},
	};
}
