import { LABEL_COLORS } from "./labels-columns";
import type { TaskLineageNode } from "./task-origin";

// ---- Epics (global, cross-project task grouping; stored in ~/.dev3.0/epics.json) ----

/**
 * One effort that may span several projects. A task points at it through
 * `Task.epicId`; membership is by id, so a rename never touches a task. Epics
 * are archived, never deleted — see decisions/2026/10/31/global-epics.md.
 */
export interface Epic {
	id: string;
	name: string;
	/** Hex colour picked by the user — user data like a label colour, not a theme token. */
	color: string;
	archived: boolean;
	createdAt: number;
}

/** The full on-disk shape of epics.json. A missing file means the empty shape. */
export interface EpicsFile {
	version: 1;
	epics: Epic[];
}

export const EMPTY_EPICS_FILE: EpicsFile = Object.freeze({ version: 1 as const, epics: [] });

export const EPIC_NAME_MAX_LENGTH = 60;

/** Epic colours reuse the label palette so chips and labels read as one family. */
export const EPIC_COLORS = LABEL_COLORS;

export function isEpicColor(value: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Case-insensitive identity of an epic name — two epics may never share it. */
export function epicNameKey(name: string): string {
	return name.trim().toLocaleLowerCase();
}

/** Error prefix that makes the CLI exit with `CLI_EXIT_CODE_EPIC_REF_INVALID`. */
export const EPIC_REF_INVALID_PREFIX = "epic-ref-invalid: ";
/** Error prefix that makes the CLI exit with `CLI_EXIT_CODE_EPIC_CREATE_FORBIDDEN`. */
export const EPIC_CREATE_FORBIDDEN_PREFIX = "epic-create-forbidden: ";

export type EpicRefResult =
	| { kind: "found"; epic: Epic }
	| { kind: "unknown" }
	| { kind: "ambiguous"; matches: Epic[] };

/**
 * Resolve what a user or agent typed: an exact id, a name (case-insensitive),
 * then an id prefix of at least 4 characters. A name always wins over a prefix
 * so an epic called "abcd" is never shadowed by an id starting with it.
 */
export function resolveEpicRef(epics: readonly Epic[], ref: string): EpicRefResult {
	const wanted = ref.trim();
	if (!wanted) return { kind: "unknown" };
	const byId = epics.find((e) => e.id === wanted);
	if (byId) return { kind: "found", epic: byId };
	const key = epicNameKey(wanted);
	const byName = epics.find((e) => epicNameKey(e.name) === key);
	if (byName) return { kind: "found", epic: byName };
	if (wanted.length < 4) return { kind: "unknown" };
	const lower = wanted.toLowerCase();
	const byPrefix = epics.filter((e) => e.id.toLowerCase().startsWith(lower));
	if (byPrefix.length === 1) return { kind: "found", epic: byPrefix[0] };
	if (byPrefix.length > 1) return { kind: "ambiguous", matches: byPrefix };
	return { kind: "unknown" };
}

/** Epics a picker may offer: everything not archived, alphabetical. */
export function pickableEpics(epics: readonly Epic[]): Epic[] {
	return epics.filter((e) => !e.archived).sort((a, b) => a.name.localeCompare(b.name));
}

/** One task in an epic, as `dev3 tasks list --epic` and the board footnote need it. */
export interface EpicMember extends TaskLineageNode {
	epicId: string;
}

/** A task's epic as `task.show` resolves it for the CLI. */
export type TaskEpicRef = Pick<Epic, "id" | "name" | "color" | "archived">;
