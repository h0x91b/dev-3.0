// File-path-looking tokens in free text: terminal output, task descriptions,
// notes. Detection only; whether a candidate names a real file is the
// resolver's call (`resolveTerminalPaths`), so false candidates are cheap.

export interface PathCandidate {
	/** Exact matched text, including any trailing :line[:col] suffix. */
	raw: string;
	/** Path with the :line[:col] suffix stripped — what gets resolved on disk. */
	cleanPath: string;
	/** 1-based line number from a :line[:col] suffix, if present. */
	line?: number;
	/** Start index in the scanned text. */
	start: number;
	/** Inclusive end index in the scanned text. */
	end: number;
}

// Either separator, so Windows paths (`C:\x`, `todo\x.md`, `.\x`) match as well
// as POSIX ones. Alternatives: drive-qualified, rooted (/, ~/, ./, ../), relative
// with a separator, and bare filenames with an alphabetic extension.
const PATH_CHARS = "\\w.@%+,=-";
// Bounded runs keep the scan linear: an unbounded run before a required
// separator backtracks quadratically on a long blob with no separator.
const SEGMENT = `[${PATH_CHARS}]{1,255}`;
const SEP = "[\\\\/]";
const PATH_REGEX = new RegExp(
	`(?<![\\w])[A-Za-z]:${SEP}(?:${SEGMENT}${SEP})*${SEGMENT}${SEP}?` +
		`|(?:~|\\.{1,2})?${SEP}(?:${SEGMENT}${SEP})*${SEGMENT}${SEP}?` +
		`|(?:${SEGMENT}${SEP})+${SEGMENT}${SEP}?` +
		`|[\\w@%+-][\\w.@%+-]{0,254}\\.[A-Za-z][A-Za-z0-9]{0,9}`,
	"g",
);

// file.ts:12 or file.ts:12:5 — kept in the link text, stripped for stat().
const LINE_COL_SUFFIX = /^:(\d+)(?::\d+)?/;
const TRAILING_PUNCTUATION = /[.,;:!?'"`)\]}>]+$/;
const MIN_CANDIDATE_LEN = 3;

/** A longer line is scanned in overlapping windows of this size, so one scan stays short. */
const WINDOW = 4096;
const WINDOW_OVERLAP = 512;

/** Find file-path-looking tokens in text, line by line; offsets are into `text`. */
export function findPathCandidates(text: string): PathCandidate[] {
	const candidates: PathCandidate[] = [];
	let offset = 0;
	for (const line of text.split("\n")) {
		if (line.length <= WINDOW) {
			scanLine(line, offset, candidates);
		} else {
			// A candidate a window cut short reappears whole in the next window; keep the longest per start.
			const found = new Map<number, PathCandidate>();
			for (let at = 0; at < line.length; at += WINDOW - WINDOW_OVERLAP) {
				const part: PathCandidate[] = [];
				scanLine(line.slice(at, at + WINDOW), offset + at, part);
				for (const c of part) if (!found.has(c.start) || found.get(c.start)!.end < c.end) found.set(c.start, c);
				if (at + WINDOW >= line.length) break;
			}
			const sorted = [...found.values()].sort((a, b) => a.start - b.start);
			let lastEnd = -1;
			for (const c of sorted) {
				if (c.start <= lastEnd) continue;
				candidates.push(c);
				lastEnd = c.end;
			}
		}
		offset += line.length + 1;
	}
	return candidates;
}

function scanLine(text: string, offset: number, candidates: PathCandidate[]): void {
	// Every candidate holds a separator or a dot; text with neither costs no regex pass.
	if (!/[./\\]/.test(text)) return;
	PATH_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PATH_REGEX.exec(text)) !== null) {
		let raw = match[0];
		const before = match.index > 0 ? text[match.index - 1] : "";
		// Skip URL tails ("https://foo.com/bar" matching at "//foo…") and a UNC
		// share's second backslash: neither names a path on its own.
		if (before === ":" || before === "/" || before === "\\") continue;
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
			start: offset + match.index,
			end: offset + match.index + raw.length - 1,
		});
	}
}

/** An absolute or home path on any platform: `/x`, `~/x`, `~\x`, `C:\x`, `C:/x`, `\\server\share`. */
export function isRootedPathText(path: string): boolean {
	return /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/** The last segment of a path written with either separator. */
export function pathBaseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}
