/**
 * Immutable on-disk STAGING of native terminal host images (seq 1248).
 *
 * An app update stages a new host image as its own immutable directory beside
 * the ones already installed; it NEVER rewrites an existing image. Each image
 * directory holds:
 *
 *   <stagingRoot>/<tag>/
 *     image.json      # the manifest (immutable)
 *     <entrypoint>     # generated launch shim (immutable) — bun re-enters it
 *
 * Reads return an honest three-way verdict — ok / missing / partial — so a
 * launcher, a rollback, or a diagnostic never has to guess whether an image is
 * usable, and a partially-written image is reported rather than launched. Never
 * touches, renames, or deletes any existing session state; staging is additive.
 *
 * node:fs / node:path / node:crypto only (no Bun runtime) so the logic is
 * unit-testable under the vitest Bun stub.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertValidImageTag,
	HOST_IMAGE_SCHEMA_VERSION,
	isValidImageTag,
	parseManifest,
	serializeManifest,
	type StagedHostImageManifest,
} from "./image-manifest";

export const MANIFEST_FILE = "image.json";

export function imageDir(root: string, tag: string): string {
	assertValidImageTag(tag);
	return join(root, tag);
}

export function manifestPath(root: string, tag: string): string {
	return join(imageDir(root, tag), MANIFEST_FILE);
}

/** Absolute path to the host runtime the generated shim re-enters. Overridable for tests. */
export function defaultRuntimeModulePath(): string {
	return fileURLToPath(new URL("./staged-host-runtime.ts", import.meta.url));
}

export interface StageHostImageSpec {
	tag: string;
	protocolVersion: number;
	hostArtifactVersion?: string;
	runtimeFloor?: string;
	/** ISO timestamp; injected so staging stays deterministic and clock-free. */
	stagedAt: string;
	/** Entrypoint filename written into the image dir. Default `entrypoint.mjs`. */
	entrypoint?: string;
	/** Absolute path the shim imports the host runtime from. Default: the module runtime. */
	runtimeModulePath?: string;
}

/** Thrown when staging would overwrite an already-staged, immutable image. */
export class HostImageAlreadyStagedError extends Error {
	constructor(public readonly tag: string) {
		super(`staged host image ${JSON.stringify(tag)} already exists and is immutable; stage a new tag instead of rewriting it`);
		this.name = "HostImageAlreadyStagedError";
	}
}

/**
 * The immutable launch shim written into an image dir. It bakes in the tag +
 * protocol version (so two images are genuinely distinct files) and re-enters
 * the shared host runtime by absolute path, keeping the runtime's relative
 * imports intact. Bun runs this file as the detached host's argv[1].
 */
function shimSource(spec: Required<Pick<StageHostImageSpec, "tag" | "protocolVersion">> & { runtimeModulePath: string }): string {
	return [
		"// dev3 staged native terminal host image entrypoint — IMMUTABLE (seq 1248).",
		"// Generated at staging time; two images differ by tag + protocolVersion below.",
		`// tag=${spec.tag} protocolVersion=${spec.protocolVersion}`,
		`import { runStagedHost } from ${JSON.stringify(spec.runtimeModulePath)};`,
		`runStagedHost({ expectedTag: ${JSON.stringify(spec.tag)}, expectedProtocolVersion: ${spec.protocolVersion} });`,
		"",
	].join("\n");
}

/**
 * Stage a new immutable host image. Refuses to overwrite an existing image
 * (HostImageAlreadyStagedError) — the only way to "replace" a host is to stage a
 * new tag, which is what proves an update never rewrites a running session's
 * executable in place. Returns the written manifest.
 */
export function stageHostImage(root: string, spec: StageHostImageSpec): StagedHostImageManifest {
	assertValidImageTag(spec.tag);
	const dir = imageDir(root, spec.tag);
	const manifestFile = manifestPath(root, spec.tag);
	if (existsSync(manifestFile)) throw new HostImageAlreadyStagedError(spec.tag);

	const entrypoint = spec.entrypoint ?? "entrypoint.mjs";
	const manifest: StagedHostImageManifest = {
		imageSchemaVersion: HOST_IMAGE_SCHEMA_VERSION,
		tag: spec.tag,
		protocolVersion: spec.protocolVersion,
		hostArtifactVersion: spec.hostArtifactVersion ?? String(spec.protocolVersion),
		entrypoint,
		runtimeFloor: spec.runtimeFloor ?? "1.3.14",
		stagedAt: spec.stagedAt,
	};

	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Entrypoint first, manifest last: a reader that sees a valid manifest can
	// always find the entrypoint it names (mirrors token-before-record ordering).
	writeFileSync(
		join(dir, entrypoint),
		shimSource({ tag: spec.tag, protocolVersion: spec.protocolVersion, runtimeModulePath: spec.runtimeModulePath ?? defaultRuntimeModulePath() }),
		{ mode: 0o500 },
	);
	writeFileSync(manifestFile, serializeManifest(manifest), { mode: 0o400 });
	return manifest;
}

export type StagedImageResult =
	| { status: "ok"; tag: string; imageDir: string; entrypointPath: string; manifest: StagedHostImageManifest }
	| { status: "missing"; tag: string; reason: string }
	| { status: "partial"; tag: string; imageDir: string; missing: string[]; reason: string };

/** Read one staged image with an honest ok / missing / partial verdict. Never throws for a bad image. */
export function readStagedImage(root: string, tag: string): StagedImageResult {
	if (!isValidImageTag(tag)) return { status: "missing", tag, reason: `invalid image tag ${JSON.stringify(tag)}` };
	const dir = imageDir(root, tag);
	if (!existsSync(dir)) return { status: "missing", tag, reason: `no staged image directory at ${dir}` };

	const manifestFile = manifestPath(root, tag);
	if (!existsSync(manifestFile)) {
		return { status: "partial", tag, imageDir: dir, missing: [MANIFEST_FILE], reason: `image ${tag} is missing its ${MANIFEST_FILE} manifest` };
	}
	let manifestText: string;
	try {
		manifestText = readFileSync(manifestFile, "utf8");
	} catch (err) {
		return { status: "partial", tag, imageDir: dir, missing: [MANIFEST_FILE], reason: `image ${tag} manifest is unreadable: ${String(err)}` };
	}
	const manifest = parseManifest(manifestText);
	if (!manifest) {
		return { status: "partial", tag, imageDir: dir, missing: [MANIFEST_FILE], reason: `image ${tag} manifest is corrupt or a foreign schema` };
	}
	if (manifest.tag !== tag) {
		return { status: "partial", tag, imageDir: dir, missing: [MANIFEST_FILE], reason: `image ${tag} manifest declares a different tag ${JSON.stringify(manifest.tag)}` };
	}
	const entrypointPath = join(dir, manifest.entrypoint);
	if (!existsSync(entrypointPath)) {
		return { status: "partial", tag, imageDir: dir, missing: [manifest.entrypoint], reason: `image ${tag} is missing its entrypoint ${manifest.entrypoint}` };
	}
	return { status: "ok", tag, imageDir: dir, entrypointPath, manifest };
}

export type OkImage = Extract<StagedImageResult, { status: "ok" }>;
export type IncompleteImage = Extract<StagedImageResult, { status: "partial" | "missing" }>;

export interface StagedImageListing {
	ok: OkImage[];
	incomplete: IncompleteImage[];
}

/** Classify every image directory under `root`. Returns empty listings when root is absent. */
export function listStagedImages(root: string): StagedImageListing {
	const ok: OkImage[] = [];
	const incomplete: IncompleteImage[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && isValidImageTag(entry.name))
			.map((entry) => entry.name);
	} catch {
		return { ok, incomplete };
	}
	for (const tag of entries.sort()) {
		const result = readStagedImage(root, tag);
		if (result.status === "ok") ok.push(result);
		else incomplete.push(result);
	}
	return { ok, incomplete };
}

/**
 * A stable content fingerprint of an image directory (sorted filename + bytes).
 * Lets a proof assert an image was NOT rewritten in place after a newer image
 * was staged beside it. Returns null when the directory is absent.
 */
export function fingerprintImage(root: string, tag: string): string | null {
	const dir = imageDir(root, tag);
	if (!existsSync(dir)) return null;
	const hash = createHash("sha256");
	let files: string[];
	try {
		files = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return null;
	}
	for (const name of files) {
		hash.update(name);
		hash.update("\0");
		try {
			hash.update(readFileSync(join(dir, name)));
		} catch {
			hash.update("<unreadable>");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** True when `child` lives directly in `parent` — the per-image entrypoint guard. */
export function isPathInside(parent: string, child: string): boolean {
	return resolve(dirname(child)) === resolve(parent);
}
