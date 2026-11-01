/**
 * Board-view extensions (spec `board-views-spec.md` §4.3, D10–D12, D16, D24): the manifest format,
 * its validation, and the host-side state. Pure — the bun side does the file I/O and semver.
 */

/** The version of the board-view contract (`ctx.board`, `ctx.boardViews`) an extension's `engines.dev3` is matched against. */
export const EXTENSION_API_VERSION = "1.0.0";

export const EXTENSION_MANIFEST_FILE = "dev3-extension.json";
export const EXTENSION_MAIN_FILE = "index.js";
/** A prebuilt bundle bigger than this is refused before it is ever read into the renderer. */
export const EXTENSION_MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/** Built-in board views a user may switch off. Kanban is not one of them: it is the fallback (D16). */
export const TOGGLEABLE_BUILTIN_VIEWS = ["builtin:table", "builtin:tree", "builtin:attention"] as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VIEW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_IDS = new Set(["builtin", "dev3", "third-party", "third_party"]);

export interface ExtensionViewContribution {
	/** Local id; the registered view id is `<extensionId>:<id>`. */
	id: string;
	label: string;
}

export interface ExtensionManifest {
	id: string;
	name: string;
	version: string;
	publisher: string;
	/** A semver range over `EXTENSION_API_VERSION`. */
	engines: { dev3: string };
	contributes: { boardViews: ExtensionViewContribution[] };
	main: typeof EXTENSION_MAIN_FILE;
}

export type ExtensionStatus = "active" | "disabled" | "incompatible" | "invalid" | "untrusted";

/** One folder under `~/.dev3.0/extensions/`, as the scanner saw it. No field comes from executing its code. */
export interface InstalledExtension {
	/** The folder name; equal to `manifest.id` whenever the manifest is valid. */
	id: string;
	manifest: ExtensionManifest | null;
	status: ExtensionStatus;
	/** Why it is invalid or incompatible; absent otherwise. */
	problem?: string;
	consentedAt?: string;
}

export type ExtensionsLockSource = "env" | null;

export interface ExtensionsOverview {
	/** The effective kill switch: false means no third-party code loads this launch. */
	enabled: boolean;
	/** The stored user choice, which the env override may outrank. */
	enabledSetting: boolean;
	lockedBy: ExtensionsLockSource;
	apiVersion: string;
	disabledBuiltins: string[];
	extensions: InstalledExtension[];
}

/** What the consent modal shows before anything is copied. */
export interface ExtensionInspection {
	manifest: ExtensionManifest;
	/** Absolute folder the user picked. */
	sourcePath: string;
	compatible: boolean;
	problem?: string;
	/** True when this id is already trusted for the same publisher, so no consent is asked (D10: first install only). */
	alreadyTrusted: boolean;
}

/** `~/.dev3.0/extensions-state.json` — a new sidecar file, never part of `settings.json`. */
export interface ExtensionsStateFile {
	version: 1;
	/** Kill switch: an explicit false turns every third-party extension off. */
	enabled?: false;
	disabledBuiltins: string[];
	disabledExtensions: string[];
	trust: Record<string, { publisher: string; consentedAt: string }>;
}

export function emptyExtensionsState(): ExtensionsStateFile {
	return { version: 1, disabledBuiltins: [], disabledExtensions: [], trust: {} };
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))] : [];
}

export function normalizeExtensionsState(raw: unknown): ExtensionsStateFile {
	const state = emptyExtensionsState();
	if (!raw || typeof raw !== "object") return state;
	const r = raw as Record<string, unknown>;
	if (r.enabled === false) state.enabled = false;
	state.disabledBuiltins = stringList(r.disabledBuiltins).filter((id) => (TOGGLEABLE_BUILTIN_VIEWS as readonly string[]).includes(id));
	state.disabledExtensions = stringList(r.disabledExtensions);
	if (r.trust && typeof r.trust === "object") {
		for (const [id, record] of Object.entries(r.trust as Record<string, unknown>)) {
			const rec = record as Record<string, unknown> | null;
			if (isValidExtensionId(id) && rec && typeof rec.publisher === "string" && typeof rec.consentedAt === "string") {
				state.trust[id] = { publisher: rec.publisher, consentedAt: rec.consentedAt };
			}
		}
	}
	return state;
}

export function isValidExtensionId(id: string): boolean {
	return ID_PATTERN.test(id) && !RESERVED_IDS.has(id);
}

function nonEmptyString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type ManifestValidation = { ok: true; manifest: ExtensionManifest } | { ok: false; error: string };

/**
 * Validates a parsed `dev3-extension.json` without executing anything. `folderName`
 * is the directory it was found in, which must equal the id once installed.
 * Whether the `engines.dev3` range matches this host is `satisfiesRange`'s job.
 */
export function validateExtensionManifest(raw: unknown, folderName?: string): ManifestValidation {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "manifest is not a JSON object" };
	const m = raw as Record<string, unknown>;
	if (typeof m.id !== "string" || !isValidExtensionId(m.id)) {
		return { ok: false, error: "id must be 2-64 chars of a-z, 0-9 and '-', not a reserved name" };
	}
	if (folderName !== undefined && folderName !== m.id) return { ok: false, error: `folder name "${folderName}" does not match id "${m.id}"` };
	if (!nonEmptyString(m.name, 80)) return { ok: false, error: "name is required (max 80 chars)" };
	if (typeof m.version !== "string" || !VERSION_PATTERN.test(m.version)) return { ok: false, error: "version must be semver, e.g. 1.0.0" };
	if (!nonEmptyString(m.publisher, 80)) return { ok: false, error: "publisher is required (max 80 chars)" };
	const engines = m.engines as Record<string, unknown> | undefined;
	if (!engines || typeof engines !== "object" || !nonEmptyString(engines.dev3, 64)) {
		return { ok: false, error: "engines.dev3 is required, e.g. \"^1.0.0\"" };
	}
	const main = m.main ?? EXTENSION_MAIN_FILE;
	if (main !== EXTENSION_MAIN_FILE) return { ok: false, error: `main must be "${EXTENSION_MAIN_FILE}"` };
	const contributes = m.contributes as Record<string, unknown> | undefined;
	const views = contributes && typeof contributes === "object" ? contributes.boardViews : undefined;
	if (!Array.isArray(views) || views.length === 0) return { ok: false, error: "contributes.boardViews must list at least one view" };
	if (views.length > 16) return { ok: false, error: "contributes.boardViews lists more than 16 views" };
	const seen = new Set<string>();
	const boardViews: ExtensionViewContribution[] = [];
	for (const view of views) {
		const v = view as Record<string, unknown> | null;
		if (!v || typeof v.id !== "string" || !VIEW_ID_PATTERN.test(v.id)) return { ok: false, error: "each board view needs an id of a-z, 0-9 and '-'" };
		if (seen.has(v.id)) return { ok: false, error: `board view "${v.id}" is listed twice` };
		if (!nonEmptyString(v.label, 40)) return { ok: false, error: `board view "${v.id}" needs a label (max 40 chars)` };
		seen.add(v.id);
		boardViews.push({ id: v.id, label: v.label.trim() });
	}
	return {
		ok: true,
		manifest: {
			id: m.id,
			name: (m.name as string).trim(),
			version: m.version,
			publisher: (m.publisher as string).trim(),
			engines: { dev3: (engines.dev3 as string).trim() },
			contributes: { boardViews },
			main: EXTENSION_MAIN_FILE,
		},
	};
}

/** The full registered id of a contributed view. */
export function extensionViewId(extensionId: string, viewId: string): string {
	return `${extensionId}:${viewId}`;
}

/**
 * The only form a board view id may take in telemetry (telemetry rule 1): a built-in
 * keeps its id, anything else — every extension — collapses to `third_party`, so no
 * extension id or name ever leaves the machine.
 */
export function boardViewTelemetryId(viewId: string): string {
	return /^builtin:[a-z0-9-]+$/.test(viewId) ? viewId : "third_party";
}

/** `DEV3_EXTENSIONS=off` (also `0`, `false`, `no`) forces every third-party extension off. */
export function extensionsEnvLock(value: string | undefined): boolean {
	return typeof value === "string" && ["off", "0", "false", "no"].includes(value.trim().toLowerCase());
}

type Triple = [number, number, number];

function parseLoose(text: string): { parts: Triple; given: number } | null {
	const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
	if (!match) return null;
	const raw = [match[1], match[2], match[3]];
	let given = 0;
	const parts = [0, 0, 0] as Triple;
	for (let i = 0; i < 3; i++) {
		const piece = raw[i];
		if (piece === undefined || /^[xX*]$/.test(piece)) break;
		parts[i] = Number(piece);
		given = i + 1;
	}
	return { parts, given };
}

function compare(a: Triple, b: Triple): number {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	return 0;
}

/** The exclusive upper bound of a partial version: `1` → `2.0.0`, `1.2` → `1.3.0`. */
function bump(parts: Triple, given: number): Triple {
	if (given <= 1) return [parts[0] + 1, 0, 0];
	return [parts[0], parts[1] + 1, 0];
}

function comparatorMatches(version: Triple, comparator: string): boolean | null {
	const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(comparator);
	if (!match) return null;
	const op = match[1] ?? "";
	const target = parseLoose(match[2]);
	if (!target) return null;
	const { parts, given } = target;
	const c = compare(version, parts);
	if (given === 0) return op === "" || op === "=" || op === ">=" || op === "^" || op === "~" ? true : op === "<=" ;
	switch (op) {
		case ">=": return c >= 0;
		case ">": return given < 3 ? compare(version, bump(parts, given)) >= 0 : c > 0;
		case "<": return c < 0;
		case "<=": return given < 3 ? compare(version, bump(parts, given)) < 0 : c <= 0;
		case "~": return c >= 0 && compare(version, given >= 2 ? [parts[0], parts[1] + 1, 0] : [parts[0] + 1, 0, 0]) < 0;
		case "^": {
			const upper: Triple = parts[0] > 0 || given === 1 ? [parts[0] + 1, 0, 0]
				: parts[1] > 0 || given === 2 ? [0, parts[1] + 1, 0]
				: [0, 0, parts[2] + 1];
			return c >= 0 && compare(version, upper) < 0;
		}
		default: return given === 3 ? c === 0 : c >= 0 && compare(version, bump(parts, given)) < 0;
	}
}

/**
 * npm-style range check for `engines.dev3`: `^`, `~`, `>=`/`>`/`<=`/`<`, `=`, `x`/`*`
 * wildcards, space-joined comparators (AND) and `||` (OR). Hyphen ranges and
 * prerelease semantics are not supported; an unparsable range never matches.
 */
export function satisfiesRange(version: string, range: string): boolean {
	const parsed = parseLoose(version.trim());
	if (!parsed || parsed.given !== 3) return false;
	const alternatives = range.split("||").map((alt) => alt.trim());
	if (alternatives.length === 0) return false;
	return alternatives.some((alt) => {
		if (alt === "") return alternatives.length === 1;
		const comparators = alt.replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/);
		return comparators.every((comparator) => comparatorMatches(parsed.parts, comparator) === true);
	});
}
