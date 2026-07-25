/**
 * Deterministic manifest for a STAGED native terminal host artifact (prereq of
 * RUN-006, the tmux-removal roadmap seq 1141). This module is intentionally
 * decoupled from packaging, signing, updating, and runtime selection: it only
 * describes an already-staged artifact directory so a later step can verify it.
 *
 * Contract:
 *   • generateManifest() takes an artifact root, an explicit declared file list,
 *     and explicit build metadata, and returns a manifest whose per-file entries
 *     carry the exact byte size and SHA-256 of the file on disk.
 *   • serializeManifest() renders byte-identical JSON for identical input,
 *     independent of declared-file order, filesystem enumeration order, and file
 *     timestamps (no clock is read; files are sorted by their POSIX path).
 *   • validateManifest() re-checks an existing manifest against a root: every
 *     declared file must be inside the root, present, a regular file, non-empty,
 *     and hash to the recorded checksum from its exact bytes.
 *
 * Rejections surface as a single typed ManifestError carrying a compact `code`
 * (see ManifestErrorCode) plus an optional path/paths detail. Pure node:* only
 * (fs/path/crypto) so it runs under Bun directly and is unit-testable.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Frozen manifest schema version. A breaking change bumps this explicitly. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** OS value space mirrors `process.platform` so consumers compare without translation. */
export const MANIFEST_OS_VALUES = ["win32", "darwin", "linux"] as const;
/** Architecture value space mirrors `process.arch`. */
export const MANIFEST_ARCH_VALUES = ["x64", "arm64"] as const;

export type ManifestOs = (typeof MANIFEST_OS_VALUES)[number];
export type ManifestArch = (typeof MANIFEST_ARCH_VALUES)[number];

export interface ManifestFileEntry {
	/** POSIX (forward-slash) path relative to the artifact root. */
	path: string;
	/** Exact byte length of the file. */
	size: number;
	/** Lowercase hex SHA-256 of the exact file bytes. */
	sha256: string;
}

export interface ManifestMetadata {
	hostVersion: string;
	protocolVersion: number;
	bunVersion: string;
	os: ManifestOs;
	arch: ManifestArch;
}

export interface NativeHostManifest {
	manifestSchemaVersion: typeof MANIFEST_SCHEMA_VERSION;
	hostVersion: string;
	protocolVersion: number;
	bunVersion: string;
	os: ManifestOs;
	arch: ManifestArch;
	/** POSIX path of the launch entrypoint; always one of `files[].path`. */
	entrypoint: string;
	/** Files sorted by `path` (code-unit order), never containing duplicates. */
	files: ManifestFileEntry[];
}

export interface GenerateManifestInput {
	artifactRoot: string;
	/** Launch entrypoint, relative to the artifact root. */
	entrypoint: string;
	/** Declared files, relative to the artifact root (order-insensitive). */
	files: string[];
	metadata: ManifestMetadata;
}

export type ManifestErrorCode =
	| "missing" // the artifact root itself is absent
	| "partial" // root exists but one or more declared files are absent
	| "path-traversal" // a declared path is absolute or escapes the root
	| "duplicate" // the same POSIX path is declared twice
	| "incompatible-schema" // a parsed manifest is unreadable or a foreign schema
	| "checksum-mismatch" // recorded size/sha256 does not match the file bytes
	| "not-regular" // a declared path exists but is not a regular file
	| "empty-file" // a declared regular file has zero bytes
	| "invalid-metadata" // host/protocol/bun/os/arch metadata is malformed
	| "invalid-entrypoint" // the entrypoint is not among the declared files
	| "no-files" // an empty declared file list
	| "invalid-tag" // a packaged image tag is not a safe single directory segment
	| "invalid-runtime-carrier" // the declared Bun runtime carrier is not among the declared files
	| "invalid-archive-root" // the recorded archive root is not the image's own tag directory
	| "runtime-floor" // the packaged Bun version is below the image's own runtime floor
	| "unexpected-target"; // a validated manifest contradicts what the caller expected

export interface ManifestErrorDetail {
	path?: string;
	paths?: string[];
	expected?: string;
	actual?: string;
}

export class ManifestError extends Error {
	readonly code: ManifestErrorCode;
	readonly detail: ManifestErrorDetail;

	constructor(code: ManifestErrorCode, message: string, detail: ManifestErrorDetail = {}) {
		super(message);
		this.name = "ManifestError";
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Normalize a declared relative path to a clean POSIX path, or reject it as a
 * traversal. Accepts `\\` and `/` separators, drops `.` and empty segments,
 * and rejects absolute paths, `..` segments, Windows drive letters, and NUL.
 */
function normalizeRelativePath(input: string): string {
	if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
		throw new ManifestError("path-traversal", `declared path ${JSON.stringify(input)} is not a usable relative path`, {
			path: String(input),
		});
	}
	const rawSegments = input.split(/[\\/]+/);
	if (rawSegments[0] === "") {
		throw new ManifestError("path-traversal", `declared path ${JSON.stringify(input)} must be relative, not absolute`, { path: input });
	}
	const segments: string[] = [];
	for (const segment of rawSegments) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			throw new ManifestError("path-traversal", `declared path ${JSON.stringify(input)} escapes the artifact root`, { path: input });
		}
		if (/^[A-Za-z]:$/.test(segment)) {
			throw new ManifestError("path-traversal", `declared path ${JSON.stringify(input)} contains a drive letter`, { path: input });
		}
		segments.push(segment);
	}
	if (segments.length === 0) {
		throw new ManifestError("path-traversal", `declared path ${JSON.stringify(input)} does not name a file`, { path: input });
	}
	return segments.join("/");
}

/** Belt-and-suspenders: confirm the resolved absolute path is inside the root. */
function assertInsideRoot(rootResolved: string, posixRelative: string): string {
	const absolutePath = resolve(rootResolved, posixRelative);
	const backToRelative = relative(rootResolved, absolutePath);
	if (backToRelative === "" || backToRelative.startsWith("..") || isAbsolute(backToRelative)) {
		throw new ManifestError("path-traversal", `declared path ${JSON.stringify(posixRelative)} resolves outside the artifact root`, {
			path: posixRelative,
		});
	}
	return absolutePath;
}

function validateMetadata(metadata: ManifestMetadata): void {
	const problems: string[] = [];
	if (typeof metadata.hostVersion !== "string" || metadata.hostVersion.trim().length === 0) problems.push("hostVersion");
	if (typeof metadata.bunVersion !== "string" || metadata.bunVersion.trim().length === 0) problems.push("bunVersion");
	if (typeof metadata.protocolVersion !== "number" || !Number.isInteger(metadata.protocolVersion) || metadata.protocolVersion <= 0) {
		problems.push("protocolVersion");
	}
	if (!MANIFEST_OS_VALUES.includes(metadata.os)) problems.push("os");
	if (!MANIFEST_ARCH_VALUES.includes(metadata.arch)) problems.push("arch");
	if (problems.length > 0) {
		throw new ManifestError("invalid-metadata", `invalid build metadata: ${problems.join(", ")}`, { paths: problems });
	}
}

/** Stat + hash one declared file; classify any failure as a typed rejection. */
function checksumRegularFile(rootResolved: string, posixRelative: string): { entry: ManifestFileEntry; missing: boolean } {
	const absolutePath = assertInsideRoot(rootResolved, posixRelative);
	let stat;
	try {
		stat = lstatSync(absolutePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entry: { path: posixRelative, size: 0, sha256: "" }, missing: true };
		throw new ManifestError("not-regular", `declared file ${JSON.stringify(posixRelative)} is not accessible: ${String(err)}`, {
			path: posixRelative,
		});
	}
	if (!stat.isFile()) {
		throw new ManifestError("not-regular", `declared path ${JSON.stringify(posixRelative)} is not a regular file`, { path: posixRelative });
	}
	const bytes = readFileSync(absolutePath);
	if (bytes.length === 0) {
		throw new ManifestError("empty-file", `declared file ${JSON.stringify(posixRelative)} is empty`, { path: posixRelative });
	}
	return {
		entry: { path: posixRelative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
		missing: false,
	};
}

function assertRootExists(artifactRoot: string): string {
	const rootResolved = resolve(artifactRoot);
	let stat;
	try {
		stat = lstatSync(rootResolved);
	} catch {
		throw new ManifestError("missing", `artifact root ${JSON.stringify(artifactRoot)} does not exist`, { path: artifactRoot });
	}
	if (!stat.isDirectory()) {
		throw new ManifestError("missing", `artifact root ${JSON.stringify(artifactRoot)} is not a directory`, { path: artifactRoot });
	}
	return rootResolved;
}

/**
 * Normalize + dedupe a declared file list into sorted POSIX paths. Rejects an
 * empty list (no-files), traversal paths (path-traversal), and any path that
 * normalizes to the same POSIX path as another (duplicate).
 */
function normalizeDeclaredFiles(files: string[]): string[] {
	if (!Array.isArray(files) || files.length === 0) {
		throw new ManifestError("no-files", "at least one declared file is required");
	}
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const file of files) {
		const posix = normalizeRelativePath(file);
		if (seen.has(posix)) {
			throw new ManifestError("duplicate", `declared file ${JSON.stringify(posix)} appears more than once`, { path: posix });
		}
		seen.add(posix);
		normalized.push(posix);
	}
	return sortPaths(normalized);
}

/** Locale-independent, code-unit ordering so the manifest is byte-stable. */
function sortPaths(paths: string[]): string[] {
	return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Build a deterministic manifest for an already-staged artifact directory.
 *
 * Rejection precedence (first failure wins): invalid-metadata → no-files →
 * path-traversal → duplicate → invalid-entrypoint → missing (root) →
 * not-regular / empty-file (per file) → partial (declared files absent).
 */
export function generateManifest(input: GenerateManifestInput): NativeHostManifest {
	validateMetadata(input.metadata);
	const declared = normalizeDeclaredFiles(input.files);
	const entrypoint = normalizeRelativePath(input.entrypoint);
	if (!declared.includes(entrypoint)) {
		throw new ManifestError("invalid-entrypoint", `entrypoint ${JSON.stringify(entrypoint)} is not among the declared files`, {
			path: entrypoint,
		});
	}

	const rootResolved = assertRootExists(input.artifactRoot);
	const entries: ManifestFileEntry[] = [];
	const missing: string[] = [];
	for (const posix of declared) {
		const result = checksumRegularFile(rootResolved, posix);
		if (result.missing) missing.push(posix);
		else entries.push(result.entry);
	}
	if (missing.length > 0) {
		throw new ManifestError("partial", `artifact is missing ${missing.length} declared file(s): ${missing.join(", ")}`, { paths: missing });
	}

	return {
		manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
		hostVersion: input.metadata.hostVersion,
		protocolVersion: input.metadata.protocolVersion,
		bunVersion: input.metadata.bunVersion,
		os: input.metadata.os,
		arch: input.metadata.arch,
		entrypoint,
		files: sortEntries(entries),
	};
}

function sortEntries(entries: ManifestFileEntry[]): ManifestFileEntry[] {
	return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Byte-stable JSON: fixed key order, sorted files, trailing newline, no clock. */
export function serializeManifest(manifest: NativeHostManifest): string {
	const ordered: NativeHostManifest = {
		manifestSchemaVersion: manifest.manifestSchemaVersion,
		hostVersion: manifest.hostVersion,
		protocolVersion: manifest.protocolVersion,
		bunVersion: manifest.bunVersion,
		os: manifest.os,
		arch: manifest.arch,
		entrypoint: manifest.entrypoint,
		files: sortEntries(manifest.files).map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 })),
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Strictly parse a manifest from unknown input. Returns a typed manifest or
 * throws `incompatible-schema` — mirrors the null-on-foreign-schema discipline
 * of the on-disk record/image manifests, but as a throw so callers get a code.
 */
export function parseManifest(raw: unknown): NativeHostManifest {
	const source = typeof raw === "string" ? safeParseJson(raw) : raw;
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		throw new ManifestError("incompatible-schema", "manifest is not a JSON object");
	}
	const m = source as Record<string, unknown>;
	if (m.manifestSchemaVersion !== MANIFEST_SCHEMA_VERSION) {
		throw new ManifestError("incompatible-schema", `manifest schema version ${JSON.stringify(m.manifestSchemaVersion)} is not supported`, {
			expected: String(MANIFEST_SCHEMA_VERSION),
			actual: String(m.manifestSchemaVersion),
		});
	}
	if (
		typeof m.hostVersion !== "string" ||
		typeof m.bunVersion !== "string" ||
		typeof m.protocolVersion !== "number" ||
		typeof m.entrypoint !== "string" ||
		!MANIFEST_OS_VALUES.includes(m.os as ManifestOs) ||
		!MANIFEST_ARCH_VALUES.includes(m.arch as ManifestArch) ||
		!Array.isArray(m.files)
	) {
		throw new ManifestError("incompatible-schema", "manifest is missing or has malformed required fields");
	}
	const files: ManifestFileEntry[] = m.files.map((rawEntry) => {
		if (!rawEntry || typeof rawEntry !== "object") throw new ManifestError("incompatible-schema", "manifest file entry is not an object");
		const entry = rawEntry as Record<string, unknown>;
		if (typeof entry.path !== "string" || typeof entry.size !== "number" || typeof entry.sha256 !== "string") {
			throw new ManifestError("incompatible-schema", "manifest file entry has malformed fields");
		}
		return { path: entry.path, size: entry.size, sha256: entry.sha256 };
	});
	return {
		manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
		hostVersion: m.hostVersion,
		protocolVersion: m.protocolVersion,
		bunVersion: m.bunVersion,
		os: m.os as ManifestOs,
		arch: m.arch as ManifestArch,
		entrypoint: m.entrypoint,
		files,
	};
}

function safeParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new ManifestError("incompatible-schema", "manifest is not valid JSON");
	}
}

/**
 * Re-verify an existing manifest against an artifact root: every declared file
 * must be inside the root, present, regular, non-empty, and hash to exactly the
 * recorded size + sha256. Returns the parsed manifest on success.
 *
 * Rejection precedence: incompatible-schema → duplicate → path-traversal →
 * missing (root) → not-regular / empty-file (per file) → partial (absent files)
 * → checksum-mismatch.
 */
export function validateManifest(raw: unknown, artifactRoot: string): NativeHostManifest {
	const manifest = parseManifest(raw);

	const seen = new Set<string>();
	for (const entry of manifest.files) {
		const posix = normalizeRelativePath(entry.path);
		if (seen.has(posix)) {
			throw new ManifestError("duplicate", `manifest declares ${JSON.stringify(posix)} more than once`, { path: posix });
		}
		seen.add(posix);
	}

	const rootResolved = assertRootExists(artifactRoot);
	const missing: string[] = [];
	for (const entry of manifest.files) {
		const posix = normalizeRelativePath(entry.path);
		const result = checksumRegularFile(rootResolved, posix);
		if (result.missing) {
			missing.push(posix);
			continue;
		}
		if (result.entry.size !== entry.size || result.entry.sha256 !== entry.sha256) {
			throw new ManifestError("checksum-mismatch", `declared file ${JSON.stringify(posix)} does not match its recorded checksum`, {
				path: posix,
				expected: `${entry.size}:${entry.sha256}`,
				actual: `${result.entry.size}:${result.entry.sha256}`,
			});
		}
	}
	if (missing.length > 0) {
		throw new ManifestError("partial", `artifact is missing ${missing.length} declared file(s): ${missing.join(", ")}`, { paths: missing });
	}
	return manifest;
}

/**
 * Recursively enumerate regular files under `root`, returning sorted POSIX
 * relative paths. Symlinks and non-regular entries are skipped. The returned
 * order is filesystem-enumeration-independent, so feeding it to generateManifest
 * yields byte-stable output.
 */
export function enumerateArtifactFiles(root: string): string[] {
	const rootResolved = assertRootExists(root);
	const found: string[] = [];
	const walk = (dirRelative: string): void => {
		const absoluteDir = dirRelative === "" ? rootResolved : resolve(rootResolved, dirRelative);
		for (const dirent of readdirSync(absoluteDir, { withFileTypes: true })) {
			const childRelative = dirRelative === "" ? dirent.name : `${dirRelative}/${dirent.name}`;
			if (dirent.isDirectory()) walk(childRelative);
			else if (dirent.isFile()) found.push(childRelative);
		}
	};
	walk("");
	return sortPaths(found);
}
