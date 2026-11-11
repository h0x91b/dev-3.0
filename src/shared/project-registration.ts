import type { ClaudeFolderNotice } from "./claude-folder-notice";
import type { Project, Space, SpacesFile } from "./types";
import { orderSpaces } from "./types";

/**
 * Shapes and rules shared by the app and the `dev3` CLI for registering a
 * project from a shell (`dev3 projects add|clone`) and managing its spaces
 * (`dev3 spaces …`). The app's Add Project dialog stays the reference flow.
 */

/** Error prefix that makes the CLI exit with `CLI_EXIT_CODE_SPACE_REF_INVALID`. */
export const SPACE_REF_INVALID_PREFIX = "space-ref-invalid: ";

const SPACE_ID_PREFIX = "sp_";
const SHORT_SPACE_ID_HEX = 8;

/** `sp_` plus the first 8 characters of the uuid — what `dev3 spaces list` prints. */
export function shortSpaceId(id: string): string {
	return id.startsWith(SPACE_ID_PREFIX) ? id.slice(0, SPACE_ID_PREFIX.length + SHORT_SPACE_ID_HEX) : id.slice(0, SHORT_SPACE_ID_HEX);
}

/** A git remote rather than a folder: `scheme://…` or scp-style `user@host:path`. */
export function looksLikeGitUrl(value: string): boolean {
	const v = value.trim();
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[\w.-]+@[\w.-]+:/.test(v);
}

/**
 * Why `name` cannot be the folder a clone lands in, or null when it can. A URL
 * typed as the name once produced a project at `<base>/https://host/group/repo`.
 */
export function cloneDirNameProblem(name: string): string | null {
	const trimmed = name.trim();
	if (!trimmed) return "The repository folder name is empty";
	if (looksLikeGitUrl(trimmed)) {
		return `"${trimmed}" is a URL, not a folder name — give the URL as the clone source and leave the name empty to derive it`;
	}
	if (trimmed === "." || trimmed === "..") return `"${trimmed}" is not a folder name`;
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f/\\]/.test(trimmed)) return `"${trimmed}" must be a single folder name, without path separators`;
	return null;
}

function sameSpaceName(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type SpaceRefResolution =
	| { ok: true; space: Space }
	| { ok: false; reason: "not-found" | "ambiguous"; candidates: Space[] };

/**
 * Resolve what a user typed for a space: its full id, an `sp_` id prefix of at
 * least 8 hex characters, or its name (case-insensitive). Deleted spaces never
 * match, and a name two spaces share is ambiguous rather than "the first one".
 */
export function resolveSpaceRef(spaces: Space[], ref: string): SpaceRefResolution {
	const active = spaces.filter((s) => !s.deleted);
	const wanted = ref.trim();

	const exact = active.find((s) => s.id === wanted);
	if (exact) return { ok: true, space: exact };

	if (wanted.startsWith(SPACE_ID_PREFIX) && wanted.length >= SPACE_ID_PREFIX.length + SHORT_SPACE_ID_HEX) {
		const byPrefix = active.filter((s) => s.id.startsWith(wanted));
		if (byPrefix.length === 1) return { ok: true, space: byPrefix[0] };
		if (byPrefix.length > 1) return { ok: false, reason: "ambiguous", candidates: byPrefix };
	}

	const byName = active.filter((s) => sameSpaceName(s.name, wanted));
	if (byName.length === 1) return { ok: true, space: byName[0] };
	if (byName.length > 1) return { ok: false, reason: "ambiguous", candidates: byName };
	return { ok: false, reason: "not-found", candidates: [] };
}

function describeSpaces(spaces: Space[]): string {
	return spaces.map((s) => `"${s.name}" (${shortSpaceId(s.id)})`).join(", ");
}

/** The message for a ref `resolveSpaceRef` could not settle, naming what does exist. */
export function spaceRefProblem(file: SpacesFile, ref: string, resolution: Extract<SpaceRefResolution, { ok: false }>): string {
	if (resolution.reason === "ambiguous") {
		return `"${ref}" matches ${resolution.candidates.length} spaces: ${describeSpaces(resolution.candidates)}. Pass the space id instead.`;
	}
	const active = orderSpaces(file.spaces, file.order);
	return active.length === 0
		? `No space matches "${ref}" — there are no spaces yet.`
		: `No space matches "${ref}". Spaces: ${describeSpaces(active)}.`;
}

/** The active space already called `name`, if any — a second one would make the name ambiguous. */
export function spaceNamed(file: SpacesFile, name: string): Space | undefined {
	return file.spaces.find((s) => !s.deleted && sameSpaceName(s.name, name));
}

export interface CliSpaceRef {
	id: string;
	name: string;
}

/** The stable `--json` shape of one project. */
export interface CliProject {
	id: string;
	name: string;
	path: string;
	kind: "git" | "virtual";
	defaultBaseBranch: string;
	/** Every space the project belongs to, in display order. */
	spaces: CliSpaceRef[];
}

/** The stable `--json` shape of one space. Members the machine does not know are skipped. */
export interface CliSpace {
	id: string;
	name: string;
	sensitive: boolean;
	projects: Array<{ id: string; name: string; path: string }>;
}

export function toCliSpaceRef(space: Space): CliSpaceRef {
	return { id: space.id, name: space.name };
}

export function toCliProject(project: Project, file: SpacesFile): CliProject {
	return {
		id: project.id,
		name: project.name,
		path: project.path,
		kind: project.kind === "virtual" ? "virtual" : "git",
		defaultBaseBranch: project.defaultBaseBranch,
		spaces: orderSpaces(file.spaces, file.order)
			.filter((s) => s.projectIds.includes(project.id))
			.map(toCliSpaceRef),
	};
}

export function toCliSpaces(file: SpacesFile, projects: Project[]): CliSpace[] {
	const byId = new Map(projects.filter((p) => !p.deleted).map((p) => [p.id, p]));
	return orderSpaces(file.spaces, file.order).map((space) => ({
		id: space.id,
		name: space.name,
		sensitive: space.sensitive === true,
		projects: space.projectIds
			.map((id) => byId.get(id))
			.filter((p): p is Project => p !== undefined)
			.map((p) => ({ id: p.id, name: p.name, path: p.path })),
	}));
}

/** `projects.add` / `projects.clone`: `exists` means the path was already a project and nothing changed. */
export interface ProjectRegistrationResult {
	outcome: "added" | "exists";
	project: CliProject;
	createdSpaces: CliSpaceRef[];
	/** Set on `added` when the project's Claude agents will not use `~/.claude`, or were refused another folder. */
	claudeFolder?: ClaudeFolderNotice;
}

/** `spaces.change`: spaces whose last member left are deleted, exactly as in the app. */
export interface ProjectSpacesChangeResult {
	project: CliProject;
	deletedSpaces: CliSpaceRef[];
}

export type ProjectSpacesChangeMode = "set" | "add" | "remove";
