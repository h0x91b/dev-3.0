import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { DEV3_HOME } from "./paths";
import type { Epic, EpicsFile } from "../shared/types";
import { EPIC_COLORS, EPIC_NAME_MAX_LENGTH, EPIC_REF_INVALID_PREFIX, epicNameKey, isEpicColor, resolveEpicRef } from "../shared/types";

// Additive sibling file (AGENTS.md on-disk rule 5): older app versions never
// read it, and it is not created until the first epic is written.
const EPICS_FILE = `${DEV3_HOME}/epics.json`;

/** A refused write (bad name, duplicate, bad colour); the message is user-facing. */
export class EpicValidationError extends Error {}

// Identity-validated cache, same as spaces-data.ts: another running instance
// may rewrite the file, so a hit is only valid while mtime+size match.
let cached: { value: EpicsFile; mtimeMs: number; size: number } | null = null;

/** Test-only. */
export function _resetEpicsCache(): void {
	cached = null;
}

function emptyFile(): EpicsFile {
	return { version: 1, epics: [] };
}

async function rawLoad(): Promise<EpicsFile> {
	let identity: { mtimeMs: number; size: number };
	try {
		const s = await stat(EPICS_FILE);
		identity = { mtimeMs: s.mtimeMs, size: s.size };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
		throw err;
	}
	if (cached && cached.mtimeMs === identity.mtimeMs && cached.size === identity.size) {
		return structuredClone(cached.value);
	}
	const parsed = JSON.parse(await readFile(EPICS_FILE, "utf8")) as EpicsFile;
	if (parsed.version !== 1 || !Array.isArray(parsed.epics)) {
		throw new Error(`Unsupported epics.json shape (version ${String(parsed.version)})`);
	}
	cached = { value: parsed, ...identity };
	return structuredClone(parsed);
}

async function mutate<T>(fn: (file: EpicsFile) => T): Promise<T> {
	return withFileLock(EPICS_FILE, async () => {
		const file = await rawLoad();
		const result = fn(file);
		await mkdir(dirname(EPICS_FILE), { recursive: true });
		await atomicWriteFile(EPICS_FILE, JSON.stringify(file, null, 2));
		cached = null;
		return result;
	});
}

function validName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new EpicValidationError("An epic needs a name");
	if (trimmed.length > EPIC_NAME_MAX_LENGTH) {
		throw new EpicValidationError(`Epic names are at most ${EPIC_NAME_MAX_LENGTH} characters`);
	}
	return trimmed;
}

function assertUniqueName(file: EpicsFile, name: string, exceptId?: string): void {
	const key = epicNameKey(name);
	const clash = file.epics.find((e) => e.id !== exceptId && epicNameKey(e.name) === key);
	if (clash) throw new EpicValidationError(`An epic named "${clash.name}" already exists${clash.archived ? " (archived)" : ""}`);
}

function validColor(color: string): string {
	if (!isEpicColor(color)) throw new EpicValidationError(`Invalid colour "${color}". Use a hex colour like #3b82f6.`);
	return color.toLowerCase();
}

/** Throws the CLI-coded error for a ref that names no single epic. */
export function epicRefError(ref: string, epics: readonly Epic[]): Error {
	const result = resolveEpicRef(epics, ref);
	if (result.kind === "ambiguous") {
		const names = result.matches.map((e) => `${e.id.slice(0, 8)} "${e.name}"`).join(", ");
		return new Error(`${EPIC_REF_INVALID_PREFIX}"${ref}" matches more than one epic: ${names}. Use a longer id or the full name.`);
	}
	return new Error(`${EPIC_REF_INVALID_PREFIX}No epic "${ref}". Run "dev3 epic list" to see them; an epic is never created from a typo.`);
}

export async function loadEpicsFile(): Promise<EpicsFile> {
	return rawLoad();
}

export async function loadEpics(): Promise<Epic[]> {
	return (await rawLoad()).epics;
}

/** The epic a ref names, or the CLI-coded error. */
export async function findEpic(ref: string): Promise<Epic> {
	const epics = await loadEpics();
	const result = resolveEpicRef(epics, ref);
	if (result.kind === "found") return result.epic;
	throw epicRefError(ref, epics);
}

export async function getEpicById(id: string): Promise<Epic | null> {
	return (await loadEpics()).find((e) => e.id === id) ?? null;
}

export async function createEpic(name: string, color?: string): Promise<Epic> {
	const trimmed = validName(name);
	return mutate((file) => {
		assertUniqueName(file, trimmed);
		const epic: Epic = {
			id: crypto.randomUUID(),
			name: trimmed,
			color: color ? validColor(color) : EPIC_COLORS[file.epics.length % EPIC_COLORS.length],
			archived: false,
			createdAt: Date.now(),
		};
		file.epics.push(epic);
		return structuredClone(epic);
	});
}

export async function updateEpic(epicId: string, changes: { name?: string; color?: string; archived?: boolean }): Promise<Epic> {
	const name = changes.name !== undefined ? validName(changes.name) : undefined;
	const color = changes.color !== undefined ? validColor(changes.color) : undefined;
	return mutate((file) => {
		const epic = file.epics.find((e) => e.id === epicId);
		if (!epic) throw new EpicValidationError(`Epic not found: ${epicId}`);
		if (name !== undefined) {
			assertUniqueName(file, name, epic.id);
			epic.name = name;
		}
		if (color !== undefined) epic.color = color;
		if (changes.archived !== undefined) epic.archived = changes.archived;
		return structuredClone(epic);
	});
}
