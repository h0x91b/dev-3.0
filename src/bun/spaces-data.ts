import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { DEV3_HOME } from "./paths";
import type { Space, SpacesFile } from "../shared/types";

// Additive sibling file (AGENTS.md on-disk rule 5): older app versions never
// read it, and it is not created until the user makes the first space.
const SPACES_FILE = `${DEV3_HOME}/spaces.json`;

export class SpaceValidationError extends Error {}

// Identity-validated cache (same idea as data.ts): another running instance
// may rewrite the file, so a hit is only valid while mtime+size match.
let cached: { value: SpacesFile; mtimeMs: number; size: number } | null = null;

/** Test-only. */
export function _resetSpacesCache(): void {
	cached = null;
}

function emptyFile(): SpacesFile {
	return { version: 1, spaces: [], order: [] };
}

async function rawLoad(): Promise<SpacesFile> {
	let identity: { mtimeMs: number; size: number };
	try {
		const s = await stat(SPACES_FILE);
		identity = { mtimeMs: s.mtimeMs, size: s.size };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
		throw err;
	}
	if (cached && cached.mtimeMs === identity.mtimeMs && cached.size === identity.size) {
		return structuredClone(cached.value);
	}
	const parsed = JSON.parse(await readFile(SPACES_FILE, "utf8")) as SpacesFile;
	if (parsed.version !== 1 || !Array.isArray(parsed.spaces) || !Array.isArray(parsed.order)) {
		throw new Error(`Unsupported spaces.json shape (version ${String(parsed.version)})`);
	}
	cached = { value: parsed, ...identity };
	return structuredClone(parsed);
}

async function rawSave(file: SpacesFile): Promise<void> {
	await mkdir(dirname(SPACES_FILE), { recursive: true });
	await atomicWriteFile(SPACES_FILE, JSON.stringify(file, null, 2));
	cached = null;
}

async function mutate<T>(fn: (file: SpacesFile) => T): Promise<T> {
	return withFileLock(SPACES_FILE, async () => {
		const file = await rawLoad();
		const result = fn(file);
		await rawSave(file);
		return result;
	});
}

function activeSpace(file: SpacesFile, spaceId: string): Space {
	const space = file.spaces.find((s) => s.id === spaceId && !s.deleted);
	if (!space) throw new SpaceValidationError(`Space not found: ${spaceId}`);
	return space;
}

/** Soft-delete in place and drop from the display order. */
function softDelete(file: SpacesFile, space: Space): void {
	space.deleted = true;
	file.order = file.order.filter((id) => id !== space.id);
}

export async function loadSpacesFile(): Promise<SpacesFile> {
	return rawLoad();
}

export async function createSpace(name: string, projectIds: string[]): Promise<Space> {
	const trimmed = name.trim();
	if (!trimmed) throw new SpaceValidationError("A space needs a name");
	const members = [...new Set(projectIds)];
	if (members.length === 0) throw new SpaceValidationError("A space is never empty — pick at least one project");
	return mutate((file) => {
		const space: Space = {
			id: `sp_${crypto.randomUUID()}`,
			name: trimmed,
			parentId: null,
			projectIds: members,
			createdAt: Date.now(),
		};
		file.spaces.push(space);
		file.order.push(space.id);
		return structuredClone(space);
	});
}

export async function renameSpace(spaceId: string, name: string): Promise<Space> {
	const trimmed = name.trim();
	if (!trimmed) throw new SpaceValidationError("A space needs a name");
	return mutate((file) => {
		const space = activeSpace(file, spaceId);
		space.name = trimmed;
		return structuredClone(space);
	});
}

/** Streamer flag on the space itself — see `isSpaceSensitive`. */
export async function setSpaceSensitive(spaceId: string, sensitive: boolean): Promise<Space> {
	return mutate((file) => {
		const space = activeSpace(file, spaceId);
		if (sensitive) space.sensitive = true;
		else delete space.sensitive;
		return structuredClone(space);
	});
}

export async function deleteSpace(spaceId: string): Promise<void> {
	await mutate((file) => {
		const space = file.spaces.find((s) => s.id === spaceId);
		if (space && !space.deleted) softDelete(file, space);
	});
}

/**
 * Replace the full membership set of one project. Spaces whose last member
 * leaves are soft-deleted automatically and reported back for the UI toast.
 */
export async function setProjectSpaces(
	projectId: string,
	spaceIds: string[],
): Promise<{ file: SpacesFile; autoDeleted: Space[] }> {
	const requested = new Set(spaceIds);
	return mutate((file) => {
		const autoDeleted: Space[] = [];
		for (const space of file.spaces) {
			if (space.deleted) continue;
			const has = space.projectIds.includes(projectId);
			if (requested.has(space.id) && !has) {
				space.projectIds.push(projectId);
			} else if (!requested.has(space.id) && has) {
				space.projectIds = space.projectIds.filter((id) => id !== projectId);
				if (space.projectIds.length === 0) {
					softDelete(file, space);
					autoDeleted.push(structuredClone(space));
				}
			}
		}
		return { file: structuredClone(file), autoDeleted };
	});
}

export async function reorderSpaces(order: string[]): Promise<SpacesFile> {
	return mutate((file) => {
		const activeIds = new Set(file.spaces.filter((s) => !s.deleted).map((s) => s.id));
		const next = order.filter((id) => activeIds.has(id));
		for (const id of file.order) if (activeIds.has(id) && !next.includes(id)) next.push(id);
		file.order = next;
		return structuredClone(file);
	});
}

export async function reorderSpaceProjects(spaceId: string, projectIds: string[]): Promise<Space> {
	return mutate((file) => {
		const space = activeSpace(file, spaceId);
		const members = new Set(space.projectIds);
		const next = projectIds.filter((id) => members.has(id));
		for (const id of space.projectIds) if (!next.includes(id)) next.push(id);
		space.projectIds = next;
		return structuredClone(space);
	});
}
