import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GitInitOffer, Project, Space, SpacesFile } from "../shared/types";
import type { ClaudeFolderNotice } from "../shared/claude-folder-notice";
import { extractRepoName, spacesOfProject } from "../shared/types";
import {
	SPACE_REF_INVALID_PREFIX,
	cloneDirNameProblem,
	resolveSpaceRef,
	spaceNamed,
	spaceRefProblem,
	shortSpaceId,
	toCliProject,
	toCliSpaceRef,
	toCliSpaces,
	type CliSpace,
	type ProjectRegistrationResult,
	type ProjectSpacesChangeMode,
	type ProjectSpacesChangeResult,
} from "../shared/project-registration";
import * as data from "./data";
import { loadSettings } from "./settings";
import { appHandlers } from "./rpc-handlers/app-handlers";
import { spacesHandlers } from "./rpc-handlers/spaces";
import { getPushMessage } from "./rpc-handlers/shared-pure";
import { createLogger } from "./logger";

/**
 * The `dev3 projects add|clone` and `dev3 spaces …` back end. Registration goes
 * through the very handlers the Add Project dialog calls, and memberships through
 * the spaces handlers, so a project added from a shell is the same record — and
 * reaches every window the same way — as one added by hand.
 */

const log = createLogger("project-registration");

export interface SpaceFlags {
	/** Existing spaces to join, by id, id prefix or name. */
	spaces?: string[];
	/** Spaces to create with the project as their first member. */
	newSpaces?: string[];
	/** Leave the project in no space at all. */
	noSpace?: boolean;
}

interface SpacePlan {
	join: Space[];
	create: string[];
	none: boolean;
}

function spaceRefError(message: string): Error {
	return new Error(`${SPACE_REF_INVALID_PREFIX}${message}`);
}

function resolveSpaces(file: SpacesFile, refs: string[]): Space[] {
	const resolved = new Map<string, Space>();
	for (const ref of refs) {
		const result = resolveSpaceRef(file.spaces, ref);
		if (!result.ok) throw spaceRefError(spaceRefProblem(file, ref, result));
		resolved.set(result.space.id, result.space);
	}
	return [...resolved.values()];
}

function newSpaceNames(file: SpacesFile, names: string[]): string[] {
	const out: string[] = [];
	for (const raw of names) {
		const name = raw.trim();
		if (!name) throw new Error("A new space needs a name");
		const taken = spaceNamed(file, name);
		if (taken) {
			throw spaceRefError(`A space named "${taken.name}" already exists (${shortSpaceId(taken.id)}). Join it with --space instead.`);
		}
		if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
	}
	return out;
}

/**
 * Checked BEFORE anything is written, so a bad ref never leaves a half-done
 * project behind — and once more right before the memberships are applied.
 */
function planSpaces(file: SpacesFile, flags: SpaceFlags): SpacePlan {
	const refs = flags.spaces ?? [];
	const names = flags.newSpaces ?? [];
	if (flags.noSpace && (refs.length > 0 || names.length > 0)) {
		throw new Error("--no-space cannot be combined with --space or --new-space");
	}
	return { join: resolveSpaces(file, refs), create: newSpaceNames(file, names), none: flags.noSpace === true };
}

async function applySpacePlan(projectId: string, plan: SpacePlan): Promise<Space[]> {
	const created: Space[] = [];
	for (const name of plan.create) {
		created.push(await spacesHandlers.createSpace({ name, projectIds: [projectId] }));
	}
	const current = spacesOfProject((await spacesHandlers.getSpaces({})).spaces, projectId).map((s) => s.id);
	// A re-added project that was removed earlier still sits in its old spaces.
	if (plan.none) {
		if (current.length > 0) await spacesHandlers.setProjectSpaces({ projectId, spaceIds: [] });
		return created;
	}
	const wanted = [...new Set([...current, ...plan.join.map((s) => s.id), ...created.map((s) => s.id)])];
	if (wanted.length !== current.length) await spacesHandlers.setProjectSpaces({ projectId, spaceIds: wanted });
	return created;
}

/** One comparable spelling of a path: symlinks resolved, no trailing slash. */
function comparablePath(path: string): string {
	let resolved = path;
	try {
		resolved = realpathSync(path);
	} catch {
		// Not on disk (yet) — the raw spelling still compares against raw spellings.
	}
	return withoutTrailingSlash(resolved);
}

function withoutTrailingSlash(path: string): string {
	const trimmed = path.replace(/[/\\]+$/, "");
	return trimmed || path;
}

async function findRegisteredProject(path: string): Promise<Project | null> {
	const target = comparablePath(path);
	return (await data.loadProjects()).find((p) => p.kind !== "virtual" && comparablePath(p.path) === target) ?? null;
}

function requireFolder(path: string, what: string): string {
	if (!path || !isAbsolute(path)) throw new Error(`${what} must be an absolute path: ${path || "(empty)"}`);
	if (!existsSync(path)) throw new Error(`${what} does not exist: ${path}`);
	if (!statSync(path).isDirectory()) throw new Error(`${what} is not a folder: ${path}`);
	return withoutTrailingSlash(path);
}

function gitInitAdvice(offer: GitInitOffer): string {
	const placeholder = "a first commit holding only a placeholder .dev3/README.md";
	return offer.mode === "init"
		? `${offer.path} is not a git repository. Pass --init to run git init there and make ${placeholder}; nothing already in the folder is committed.`
		: `${offer.path} is a git repository with no commits yet, so task worktrees cannot be created. Commit first, or pass --init to make ${placeholder}; anything you staged stays staged.`;
}

async function existingOutcome(project: Project): Promise<ProjectRegistrationResult> {
	return { outcome: "exists", project: toCliProject(project, await spacesHandlers.getSpaces({})), createdSpaces: [] };
}

async function finishRegistration(project: Project, flags: SpaceFlags, claudeFolder?: ClaudeFolderNotice): Promise<ProjectRegistrationResult> {
	// Announced first: the project exists whatever happens to its memberships next.
	getPushMessage()?.("projectAdded", { project });
	let created: Space[];
	try {
		// Planned again on the file as it is NOW: a clone can take minutes, and a space deleted,
		// or a same-named one created, in the meantime must not slip through.
		const plan = planSpaces(await spacesHandlers.getSpaces({}), flags);
		created = await applySpacePlan(project.id, plan);
	} catch (err) {
		// No space-ref prefix past this point: the project WAS written, so this is not exit 34.
		const reason = err instanceof Error ? err.message.replace(SPACE_REF_INVALID_PREFIX, "") : String(err);
		log.error("Project added but its spaces could not be set", { projectId: project.id, error: reason });
		throw new Error(`Project ${project.id.slice(0, 8)} was added, but setting its spaces failed: ${reason}`);
	}
	log.info("Project registered", { projectId: project.id, created: created.length });
	return {
		outcome: "added",
		project: toCliProject(project, await spacesHandlers.getSpaces({})),
		createdSpaces: created.map(toCliSpaceRef),
		...(claudeFolder ? { claudeFolder } : {}),
	};
}

export async function registerProject(params: SpaceFlags & { path: string; name?: string; init?: boolean }): Promise<ProjectRegistrationResult> {
	const path = requireFolder(params.path, "Project folder");
	planSpaces(await spacesHandlers.getSpaces({}), params);
	const existing = await findRegisteredProject(path);
	if (existing) return existingOutcome(existing);

	const name = params.name?.trim() || undefined;
	const result = params.init
		? await appHandlers.initAndAddProject({ path, name, initNonEmpty: true })
		: await appHandlers.addProject({ path, name });
	if (!result.ok) throw new Error(result.gitInit ? gitInitAdvice(result.gitInit) : result.error);
	return finishRegistration(result.project, params, result.claudeFolder);
}

export async function cloneProject(params: SpaceFlags & { url: string; dir?: string; name?: string }): Promise<ProjectRegistrationResult> {
	const url = params.url?.trim();
	if (!url) throw new Error("A git URL is required");
	const configuredDir = params.dir?.trim() || (await loadSettings()).cloneBaseDirectory;
	if (!configuredDir) {
		throw new Error("No clone folder: pass --dir <parent folder>, or pick one once in the app (Add Project → Clone)");
	}
	const baseDir = requireFolder(configuredDir, "Clone folder");
	const repoName = params.name?.trim() || extractRepoName(url);
	const nameProblem = cloneDirNameProblem(repoName);
	if (nameProblem) throw new Error(nameProblem);
	planSpaces(await spacesHandlers.getSpaces({}), params);

	const existing = await findRegisteredProject(`${baseDir}/${repoName}`);
	if (existing) return existingOutcome(existing);

	const result = await appHandlers.cloneAndAddProject({ url, baseDir, repoName });
	if (!result.ok) throw new Error(result.error);
	return finishRegistration(result.project, params, result.claudeFolder);
}

async function activeProject(projectId: string): Promise<Project> {
	const all = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	const project = all.find((p) => p.id === projectId);
	if (!project) throw new Error(`Project not found: ${projectId}`);
	return project;
}

export async function listSpaces(): Promise<SpacesFile> {
	return spacesHandlers.getSpaces({});
}

export async function createSpaceWith(params: { name: string; projectIds: string[] }): Promise<CliSpace> {
	const name = params.name?.trim();
	if (!name) throw new Error("A space needs a name");
	const ids = [...new Set(params.projectIds)];
	if (ids.length === 0) throw new Error("A space is never empty — name at least one project");
	const before = await spacesHandlers.getSpaces({});
	const taken = spaceNamed(before, name);
	if (taken) throw spaceRefError(`A space named "${taken.name}" already exists (${shortSpaceId(taken.id)}).`);
	for (const id of ids) await activeProject(id);

	const space = await spacesHandlers.createSpace({ name, projectIds: ids });
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	const created = toCliSpaces(await spacesHandlers.getSpaces({}), projects).find((s) => s.id === space.id);
	if (!created) throw new Error(`Space ${shortSpaceId(space.id)} was created but could not be read back`);
	return created;
}

/** `set` replaces the project's whole membership, `add`/`remove` change only the named spaces. */
export async function changeProjectSpaces(params: {
	projectId: string;
	mode: ProjectSpacesChangeMode;
	spaces: string[];
}): Promise<ProjectSpacesChangeResult> {
	const project = await activeProject(params.projectId);
	const file = await spacesHandlers.getSpaces({});
	if (params.mode !== "set" && params.spaces.length === 0) throw new Error(`spaces ${params.mode} needs at least one space`);
	const named = resolveSpaces(file, params.spaces).map((s) => s.id);
	const current = spacesOfProject(file.spaces, project.id).map((s) => s.id);
	const wanted = params.mode === "set"
		? named
		: params.mode === "add"
			? [...new Set([...current, ...named])]
			: current.filter((id) => !named.includes(id));

	const unchanged = wanted.length === current.length && wanted.every((id) => current.includes(id));
	if (unchanged) return { project: toCliProject(project, file), deletedSpaces: [] };

	const { autoDeleted } = await spacesHandlers.setProjectSpaces({ projectId: project.id, spaceIds: wanted });
	return {
		project: toCliProject(project, await spacesHandlers.getSpaces({})),
		deletedSpaces: autoDeleted.map(toCliSpaceRef),
	};
}
