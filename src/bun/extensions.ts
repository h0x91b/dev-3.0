import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { DEV3_HOME } from "./paths";
import {
	EXTENSION_API_VERSION,
	EXTENSION_MAIN_FILE,
	EXTENSION_MANIFEST_FILE,
	EXTENSION_MAX_BUNDLE_BYTES,
	TOGGLEABLE_BUILTIN_VIEWS,
	extensionsEnvLock,
	isValidExtensionId,
	normalizeExtensionsState,
	validateExtensionManifest,
	type ExtensionInspection,
	type ExtensionManifest,
	type ExtensionsOverview,
	type ExtensionsStateFile,
	type InstalledExtension,
} from "../shared/extensions";

// Both are NEW siblings under ~/.dev3.0 (AGENTS.md on-disk rules 2 and 5): older
// versions never read them, and nothing here renames or migrates anything.
export function extensionsDir(): string {
	return `${DEV3_HOME}/extensions`;
}
function stateFilePath(): string {
	return `${DEV3_HOME}/extensions-state.json`;
}

export function isExtensionsEnvLocked(): boolean {
	return extensionsEnvLock(process.env.DEV3_EXTENSIONS);
}

export async function loadExtensionsState(): Promise<ExtensionsStateFile> {
	try {
		return normalizeExtensionsState(JSON.parse(await readFile(stateFilePath(), "utf8")));
	} catch {
		// Missing or torn: the defaults (everything on, nothing trusted) are the safe reading.
		return normalizeExtensionsState(null);
	}
}

/** Read-modify-write under the file lock, so two windows toggling at once never lose a change. */
export async function updateExtensionsState(change: (state: ExtensionsStateFile) => void): Promise<ExtensionsStateFile> {
	const filePath = stateFilePath();
	return withFileLock(filePath, async () => {
		const state = await loadExtensionsState();
		change(state);
		const normalized = normalizeExtensionsState(state);
		await mkdir(DEV3_HOME, { recursive: true });
		await atomicWriteFile(filePath, JSON.stringify(normalized, null, 2));
		return normalized;
	});
}

/** Whether `range` (an `engines.dev3` value) admits this host's extension API. An unparsable range is a mismatch. */
export function isApiCompatible(range: string): boolean {
	try {
		return Bun.semver.satisfies(EXTENSION_API_VERSION, range);
	} catch {
		return false;
	}
}

type ReadResult = { ok: true; manifest: ExtensionManifest } | { ok: false; error: string };

/** Reads and validates a folder's manifest and checks its bundle exists — never imports or evaluates it (D11). */
async function readExtensionFolder(dir: string, folderName?: string): Promise<ReadResult> {
	let raw: string;
	try {
		raw = await readFile(join(dir, EXTENSION_MANIFEST_FILE), "utf8");
	} catch {
		return { ok: false, error: `${EXTENSION_MANIFEST_FILE} is missing` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: `${EXTENSION_MANIFEST_FILE} is not valid JSON` };
	}
	const validation = validateExtensionManifest(parsed, folderName);
	if (!validation.ok) return validation;
	try {
		const info = await stat(join(dir, EXTENSION_MAIN_FILE));
		if (!info.isFile()) return { ok: false, error: `${EXTENSION_MAIN_FILE} is not a file` };
		if (info.size > EXTENSION_MAX_BUNDLE_BYTES) return { ok: false, error: `${EXTENSION_MAIN_FILE} is larger than 5 MB` };
	} catch {
		return { ok: false, error: `${EXTENSION_MAIN_FILE} is missing` };
	}
	return validation;
}

function incompatibility(manifest: ExtensionManifest): string | undefined {
	return isApiCompatible(manifest.engines.dev3)
		? undefined
		: `needs dev3 extension API ${manifest.engines.dev3}, this app provides ${EXTENSION_API_VERSION}`;
}

function isTrusted(state: ExtensionsStateFile, manifest: ExtensionManifest): boolean {
	return state.trust[manifest.id]?.publisher === manifest.publisher;
}

async function describeFolder(folderName: string, state: ExtensionsStateFile): Promise<InstalledExtension> {
	const result = await readExtensionFolder(join(extensionsDir(), folderName), folderName);
	if (!result.ok) return { id: folderName, manifest: null, status: "invalid", problem: result.error };
	const { manifest } = result;
	const consentedAt = state.trust[manifest.id]?.consentedAt;
	if (!isTrusted(state, manifest)) return { id: manifest.id, manifest, status: "untrusted" };
	const problem = incompatibility(manifest);
	if (problem) return { id: manifest.id, manifest, status: "incompatible", problem, consentedAt };
	const disabled = state.disabledExtensions.includes(manifest.id);
	return { id: manifest.id, manifest, status: disabled ? "disabled" : "active", consentedAt };
}

/** Every folder under `~/.dev3.0/extensions/`, sorted by id. Dotfiles and plain files are ignored. */
export async function scanExtensions(state?: ExtensionsStateFile): Promise<InstalledExtension[]> {
	const current = state ?? (await loadExtensionsState());
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(extensionsDir(), { withFileTypes: true });
	} catch {
		return [];
	}
	const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
	return Promise.all(folders.map((name) => describeFolder(name, current)));
}

export async function getExtensionsOverview(): Promise<ExtensionsOverview> {
	const state = await loadExtensionsState();
	const lockedBy = isExtensionsEnvLocked() ? "env" : null;
	const enabledSetting = state.enabled !== false;
	return {
		enabled: enabledSetting && lockedBy === null,
		enabledSetting,
		lockedBy,
		apiVersion: EXTENSION_API_VERSION,
		disabledBuiltins: state.disabledBuiltins,
		extensions: await scanExtensions(state),
	};
}

export async function inspectExtensionFolder(path: string): Promise<ExtensionInspection> {
	const sourcePath = resolve(path);
	const result = await readExtensionFolder(sourcePath);
	if (!result.ok) throw new Error(result.error);
	const state = await loadExtensionsState();
	const problem = incompatibility(result.manifest);
	return {
		manifest: result.manifest,
		sourcePath,
		compatible: !problem,
		problem,
		alreadyTrusted: isTrusted(state, result.manifest),
	};
}

/**
 * Copies the manifest and bundle — and nothing else — into `~/.dev3.0/extensions/<id>/`
 * and records trust. Consent is required unless this id is already trusted for the
 * same publisher (D10: asked only on first install, and again if the publisher changes).
 */
export async function installExtensionFromFolder(path: string, consent: boolean): Promise<InstalledExtension> {
	const inspection = await inspectExtensionFolder(path);
	const { manifest, sourcePath } = inspection;
	if (!inspection.alreadyTrusted && !consent) throw new Error("Installing an extension needs the user's consent");
	const targetDir = join(extensionsDir(), manifest.id);
	if (resolve(targetDir) !== sourcePath) {
		await mkdir(targetDir, { recursive: true });
		for (const file of [EXTENSION_MANIFEST_FILE, EXTENSION_MAIN_FILE]) {
			await atomicWriteFile(join(targetDir, file), await readFile(join(sourcePath, file), "utf8"));
		}
	}
	const state = await updateExtensionsState((s) => {
		if (!isTrusted(s, manifest)) s.trust[manifest.id] = { publisher: manifest.publisher, consentedAt: new Date().toISOString() };
		s.disabledExtensions = s.disabledExtensions.filter((id) => id !== manifest.id);
	});
	return describeFolder(manifest.id, state);
}

/** Consent for a folder that appeared without going through install (copied in by hand). */
export async function trustInstalledExtension(id: string): Promise<InstalledExtension> {
	if (!isValidExtensionId(id)) throw new Error(`Invalid extension id: ${id}`);
	const result = await readExtensionFolder(join(extensionsDir(), id), id);
	if (!result.ok) throw new Error(result.error);
	const { manifest } = result;
	const state = await updateExtensionsState((s) => {
		s.trust[id] = { publisher: manifest.publisher, consentedAt: new Date().toISOString() };
	});
	return describeFolder(id, state);
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
	if (!isValidExtensionId(id)) throw new Error(`Invalid extension id: ${id}`);
	await updateExtensionsState((s) => {
		s.disabledExtensions = s.disabledExtensions.filter((x) => x !== id);
		if (!enabled) s.disabledExtensions.push(id);
	});
}

export async function setBuiltinBoardViewEnabled(viewId: string, enabled: boolean): Promise<void> {
	if (!(TOGGLEABLE_BUILTIN_VIEWS as readonly string[]).includes(viewId)) throw new Error(`${viewId} cannot be disabled`);
	await updateExtensionsState((s) => {
		s.disabledBuiltins = s.disabledBuiltins.filter((x) => x !== viewId);
		if (!enabled) s.disabledBuiltins.push(viewId);
	});
}

export async function setExtensionsKillSwitch(enabled: boolean): Promise<void> {
	await updateExtensionsState((s) => {
		if (enabled) delete s.enabled;
		else s.enabled = false;
	});
}

/** Deletes one extension's own folder — only ever on the user's explicit Remove. */
export async function removeExtension(id: string): Promise<void> {
	if (!isValidExtensionId(id) || basename(id) !== id) throw new Error(`Invalid extension id: ${id}`);
	await rm(join(extensionsDir(), id), { recursive: true, force: true });
	await updateExtensionsState((s) => {
		delete s.trust[id];
		s.disabledExtensions = s.disabledExtensions.filter((x) => x !== id);
	});
}

/** The bundle text of an extension that may run right now; anything else is refused. */
export async function readExtensionSource(id: string): Promise<string> {
	if (!isValidExtensionId(id)) throw new Error(`Invalid extension id: ${id}`);
	const overview = await getExtensionsOverview();
	if (!overview.enabled) throw new Error("Extensions are turned off");
	const ext = overview.extensions.find((e) => e.id === id);
	if (!ext || ext.status !== "active") throw new Error(`Extension ${id} is not active`);
	return readFile(join(extensionsDir(), id, EXTENSION_MAIN_FILE), "utf8");
}
