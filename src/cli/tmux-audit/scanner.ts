/**
 * Pure, cross-platform scanner for the tmux dependency audit (roadmap INT-008).
 *
 * It never mutates the repository. It enumerates git-tracked files, applies a
 * documented scan boundary, and extracts stable "tmux signals" from each file so
 * the audit can classify dependencies and detect new unclassified ones.
 *
 * Detection is file-level by the literal token `tmux` (case-insensitive). That is
 * a complete signal in this repository: every tmux command flows through the
 * `TmuxClient`/`src/bun/tmux/` module or the bundled `tmux` binary, all of which
 * carry the literal token. `findHiddenGrammarFiles` guards that invariant.
 *
 * All paths are normalized to forward slashes so identities are stable on
 * Windows, macOS, and Linux.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Identifiers / kebab tokens that contain the literal `tmux` (case-insensitive). */
const LITERAL_TMUX = /[\w$-]*tmux[\w$-]*/gi;

/**
 * High-precision tmux subcommand tokens. Used to enrich fingerprints inside
 * files already flagged by the literal token, and by `findHiddenGrammarFiles`
 * to prove no tmux grammar hides in a file without the literal token. Every
 * entry is a compound `verb-noun` that does not collide with product vocabulary
 * (verified: `dev3-<id>`, `new-window`, `set-option` are deliberately excluded).
 */
const GRAMMAR_TOKENS = [
	"send-keys",
	"capture-pane",
	"split-window",
	"select-pane",
	"has-session",
	"kill-session",
	"attach-session",
	"list-panes",
	"new-session",
	"copy-mode",
] as const;

const GRAMMAR_RE = new RegExp(`\\b(?:${GRAMMAR_TOKENS.join("|")})\\b`, "g");

/** The documented boundary that decides which tracked files the audit covers. */
export interface ScanBoundary {
	/** Directory prefixes (posix, trailing slash) excluded entirely. */
	readonly excludeDirs: readonly string[];
	/**
	 * Directory prefixes holding immutable historical prose (changelogs, ADRs).
	 * Reported as known references but never inventoried or checked, because they
	 * are append-only ship history that is never edited to remove tmux.
	 */
	readonly historicalDirs: readonly string[];
	/** File extensions (lowercase, with dot) treated as binary/asset and skipped. */
	readonly excludeExtensions: readonly string[];
	/** Exact posix paths excluded (generated files, etc.). */
	readonly excludePaths: readonly string[];
}

export type BoundaryVerdict = "scan" | "historical" | "excluded";

export interface FileSignals {
	/** Forward-slash path relative to the repo root. */
	readonly path: string;
	/** Total number of tmux signal matches (literal + grammar), line-independent. */
	readonly occurrences: number;
	/** Distinct normalized signal tokens → occurrence count. Order-independent. */
	readonly tokens: Readonly<Record<string, number>>;
	/** Stable hash of the token multiset; unchanged when lines merely move. */
	readonly fingerprint: string;
}

export interface RepoScan {
	/** In-boundary files that contain at least one tmux signal, sorted by path. */
	readonly scanned: readonly FileSignals[];
	/** Historical files with tmux signals (changelogs/ADRs), sorted by path. */
	readonly historical: readonly FileSignals[];
	/** Count of in-boundary files scanned that had no tmux signal. */
	readonly cleanFileCount: number;
	/** Total tracked files enumerated before boundary filtering. */
	readonly trackedFileCount: number;
}

/** FNV-1a (64-bit) over the canonical token string — deterministic, dependency-free. */
function fnv1a(input: string): string {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	const mask = 0xffffffffffffffffn;
	for (let i = 0; i < input.length; i++) {
		hash ^= BigInt(input.charCodeAt(i));
		hash = (hash * prime) & mask;
	}
	return hash.toString(16).padStart(16, "0");
}

/** Stable fingerprint of a token multiset: sorted `token=count` pairs hashed. */
export function computeFingerprint(tokens: Readonly<Record<string, number>>): string {
	const canonical = Object.keys(tokens)
		.sort()
		.map((k) => `${k}=${tokens[k]}`)
		.join(";");
	return fnv1a(canonical);
}

/** Extract tmux signals from file contents. Pure; independent of line numbers. */
export function extractSignals(content: string): { occurrences: number; tokens: Record<string, number> } {
	const tokens: Record<string, number> = {};
	let occurrences = 0;

	for (const match of content.matchAll(LITERAL_TMUX)) {
		const token = match[0].toLowerCase();
		tokens[token] = (tokens[token] ?? 0) + 1;
		occurrences++;
	}
	for (const match of content.matchAll(GRAMMAR_RE)) {
		const token = `cmd:${match[0]}`;
		tokens[token] = (tokens[token] ?? 0) + 1;
		occurrences++;
	}

	return { occurrences, tokens };
}

function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

/** Decide how the boundary treats a repo-relative posix path. */
export function classifyBoundary(relPath: string, boundary: ScanBoundary): BoundaryVerdict {
	if (boundary.excludePaths.includes(relPath)) return "excluded";
	const ext = path.posix.extname(relPath).toLowerCase();
	if (boundary.excludeExtensions.includes(ext)) return "excluded";
	for (const dir of boundary.excludeDirs) {
		if (relPath === dir.replace(/\/$/, "") || relPath.startsWith(dir)) return "excluded";
	}
	for (const dir of boundary.historicalDirs) {
		if (relPath === dir.replace(/\/$/, "") || relPath.startsWith(dir)) return "historical";
	}
	return "scan";
}

/** List git-tracked files as forward-slash repo-relative paths. */
export function listTrackedFiles(repoRoot: string): string[] {
	const out = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return out.split("\0").filter((f) => f.length > 0).map(toPosix);
}

function readContent(repoRoot: string, relPath: string): string {
	try {
		return readFileSync(path.join(repoRoot, relPath), "utf8");
	} catch {
		return "";
	}
}

function toSignals(relPath: string, content: string): FileSignals | null {
	const { occurrences, tokens } = extractSignals(content);
	if (occurrences === 0) return null;
	return { path: relPath, occurrences, tokens, fingerprint: computeFingerprint(tokens) };
}

/** Scan the whole repository within the boundary. Never writes anything. */
export function scanRepo(repoRoot: string, boundary: ScanBoundary): RepoScan {
	const tracked = listTrackedFiles(repoRoot);
	const scanned: FileSignals[] = [];
	const historical: FileSignals[] = [];
	let cleanFileCount = 0;

	for (const relPath of tracked) {
		const verdict = classifyBoundary(relPath, boundary);
		if (verdict === "excluded") continue;
		const signals = toSignals(relPath, readContent(repoRoot, relPath));
		if (verdict === "historical") {
			if (signals) historical.push(signals);
			continue;
		}
		if (signals) scanned.push(signals);
		else cleanFileCount++;
	}

	const byPath = (a: FileSignals, b: FileSignals) => a.path.localeCompare(b.path);
	scanned.sort(byPath);
	historical.sort(byPath);
	return {
		scanned,
		historical,
		cleanFileCount,
		trackedFileCount: tracked.length,
	};
}

/**
 * Files (in the scan boundary, excluding historical) that contain tmux grammar
 * but NOT the literal token. Must be empty — otherwise the literal-token signal
 * is no longer complete and the guard test fails.
 */
export function findHiddenGrammarFiles(repoRoot: string, boundary: ScanBoundary): string[] {
	const hidden: string[] = [];
	for (const relPath of listTrackedFiles(repoRoot)) {
		if (classifyBoundary(relPath, boundary) !== "scan") continue;
		const ext = path.posix.extname(relPath).toLowerCase();
		if (boundary.excludeExtensions.includes(ext)) continue;
		const content = readContent(repoRoot, relPath);
		if (!content) continue;
		if (GRAMMAR_RE.test(content) && !/tmux/i.test(content)) hidden.push(relPath);
		GRAMMAR_RE.lastIndex = 0;
	}
	return hidden.sort();
}
