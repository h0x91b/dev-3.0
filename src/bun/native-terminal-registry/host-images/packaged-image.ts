/**
 * On-disk lifecycle of a PACKAGED native terminal host image (RUN-006 / WIN-004).
 *
 * Three operations, all deliberately dumb and honest:
 *
 *   assemble  — build `<packageRoot>/native-host-image/<tag>/` at package time
 *               from the packaged Bun carrier + bundled host entrypoint, with the
 *               merged manifest written last. Deterministic: identical bytes and
 *               metadata always produce the identical tag and manifest, so it is
 *               safe to re-run and it never rewrites a different image.
 *   discover  — locate the image inside an installed package / extracted archive
 *               with an ok / absent / partial verdict and an actionable message.
 *   stage     — copy the image, ADDITIVELY, into a staging root OUTSIDE the
 *               replaceable installation directory. An existing tag is never
 *               overwritten; a corrupt fresh copy fails and leaves nothing behind.
 *
 * Nothing here starts, adopts, or selects a host: staging is pure file work, so
 * packaging an image cannot change terminal behaviour. Selection for launch or
 * rollback goes through `selectPackagedImage`, which only reads.
 *
 * node:fs / node:path only, so it is unit-testable under the vitest Bun stub.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ManifestError, type ManifestArch, type ManifestOs } from "./artifact-manifest";
import { isValidImageTag } from "./image-manifest";
import {
	buildPackagedHostImageManifest,
	PACKAGED_HOST_IMAGE_MANIFEST_FILE,
	serializePackagedHostImageManifest,
	validatePackagedHostImageManifest,
	type PackagedHostImageExpectations,
	type PackagedHostImageManifest,
} from "./packaged-image-manifest";

/** Directory, inside the package/archive, that holds every packaged host image. */
export const PACKAGED_HOST_IMAGE_PARENT = "native-host-image";
/** Bun runtime carrier filename inside an image — also the detached host's process image name. */
export const PACKAGED_HOST_RUNTIME_CARRIER = "dev3-terminal-host.exe";
/** Bundled host entrypoint filename inside an image. */
export const PACKAGED_HOST_ENTRYPOINT = "dev3-terminal-host.js";

export interface AssemblePackagedImageInput {
	/** Root that ships in the update archive; the image is written under its `native-host-image/`. */
	packageRoot: string;
	/** Absolute path of the packaged Bun runtime (Electrobun's copied `bun.exe`). */
	runtimeSourcePath: string;
	/** Absolute path of the bundled host entrypoint (`dist/native/dev3-terminal-host.js`). */
	entrypointSourcePath: string;
	hostVersion: string;
	protocolVersion: number;
	bunVersion: string;
	runtimeFloor: string;
	os: ManifestOs;
	arch: ManifestArch;
}

export interface AssembledPackagedImage {
	tag: string;
	imageDir: string;
	manifestPath: string;
	entrypointPath: string;
	runtimeCarrierPath: string;
	manifest: PackagedHostImageManifest;
	/** True when an identical image was already present and was left untouched. */
	reused: boolean;
}

function imageManifestPath(imageDir: string): string {
	return join(imageDir, PACKAGED_HOST_IMAGE_MANIFEST_FILE);
}

function expectationsFor(input: AssemblePackagedImageInput): PackagedHostImageExpectations {
	return {
		os: input.os,
		arch: input.arch,
		bunVersion: input.bunVersion,
		protocolVersion: input.protocolVersion,
		archiveParent: PACKAGED_HOST_IMAGE_PARENT,
	};
}

/**
 * Assemble the image directory inside `packageRoot`. The tag is derived from the
 * copied bytes, so the destination is computed by staging into a scratch
 * directory first, then either reusing a byte-identical existing image or moving
 * the scratch copy into place.
 */
export function assemblePackagedImage(input: AssemblePackagedImageInput): AssembledPackagedImage {
	const parentDir = join(input.packageRoot, PACKAGED_HOST_IMAGE_PARENT);
	mkdirSync(parentDir, { recursive: true });
	const scratchDir = mkdtempSync(join(parentDir, ".assemble-"));
	try {
		copyFileSync(input.runtimeSourcePath, join(scratchDir, PACKAGED_HOST_RUNTIME_CARRIER));
		copyFileSync(input.entrypointSourcePath, join(scratchDir, PACKAGED_HOST_ENTRYPOINT));
		const manifest = buildPackagedHostImageManifest({
			imageRoot: scratchDir,
			entrypoint: PACKAGED_HOST_ENTRYPOINT,
			runtimeCarrier: PACKAGED_HOST_RUNTIME_CARRIER,
			files: [PACKAGED_HOST_RUNTIME_CARRIER, PACKAGED_HOST_ENTRYPOINT],
			metadata: {
				hostVersion: input.hostVersion,
				protocolVersion: input.protocolVersion,
				bunVersion: input.bunVersion,
				os: input.os,
				arch: input.arch,
			},
			runtimeFloor: input.runtimeFloor,
			archiveParent: PACKAGED_HOST_IMAGE_PARENT,
		});
		writeFileSync(imageManifestPath(scratchDir), serializePackagedHostImageManifest(manifest));

		const imageDir = join(parentDir, manifest.tag);
		if (existsSync(imageDir)) {
			// Same tag means same content by construction; validate rather than trust,
			// and leave the existing immutable image exactly as it is.
			const existing = readPackagedImage(imageDir, expectationsFor(input));
			if (existing.status !== "ok") {
				throw new ManifestError("partial", `existing packaged host image ${manifest.tag} is unusable: ${existing.reason}`, {
					path: imageDir,
				});
			}
			return { ...describeImage(imageDir, existing.manifest), manifest: existing.manifest, reused: true };
		}
		renameSync(scratchDir, imageDir);
		const written = readPackagedImage(imageDir, expectationsFor(input));
		if (written.status !== "ok") {
			throw new ManifestError("partial", `assembled packaged host image ${manifest.tag} failed validation: ${written.reason}`, {
				path: imageDir,
			});
		}
		return { ...describeImage(imageDir, written.manifest), manifest: written.manifest, reused: false };
	} finally {
		rmSync(scratchDir, { recursive: true, force: true });
	}
}

function describeImage(imageDir: string, manifest: PackagedHostImageManifest): Omit<AssembledPackagedImage, "manifest" | "reused"> {
	return {
		tag: manifest.tag,
		imageDir,
		manifestPath: imageManifestPath(imageDir),
		entrypointPath: join(imageDir, manifest.artifact.entrypoint),
		runtimeCarrierPath: join(imageDir, manifest.runtimeCarrier),
	};
}

export type PackagedImageRead =
	| { status: "ok"; imageDir: string; manifest: PackagedHostImageManifest }
	| { status: "absent"; imageDir: string; reason: string }
	| { status: "partial"; imageDir: string; reason: string; code?: string };

/**
 * Read + fully validate one image directory. Never throws: a caller inspecting a
 * possibly-broken install always gets an actionable verdict instead of a stack.
 */
export function readPackagedImage(imageDir: string, expectations: PackagedHostImageExpectations = {}): PackagedImageRead {
	if (!existsSync(imageDir)) return { status: "absent", imageDir, reason: `no packaged host image directory at ${imageDir}` };
	const manifestFile = imageManifestPath(imageDir);
	if (!existsSync(manifestFile)) {
		return { status: "partial", imageDir, reason: `image is missing its ${PACKAGED_HOST_IMAGE_MANIFEST_FILE} manifest` };
	}
	let raw: string;
	try {
		raw = readFileSync(manifestFile, "utf8");
	} catch (err) {
		return { status: "partial", imageDir, reason: `image manifest is unreadable: ${String(err)}` };
	}
	try {
		return { status: "ok", imageDir, manifest: validatePackagedHostImageManifest(raw, imageDir, expectations) };
	} catch (err) {
		if (err instanceof ManifestError) return { status: "partial", imageDir, reason: err.message, code: err.code };
		return { status: "partial", imageDir, reason: String(err) };
	}
}

export type PackagedImageDiscovery =
	| { status: "ok"; tag: string; imageDir: string; manifest: PackagedHostImageManifest }
	| { status: "absent"; reason: string }
	| { status: "partial"; imageDir: string; reason: string }
	| { status: "ambiguous"; tags: string[]; reason: string };

/**
 * Locate the packaged image inside an installed package or an extracted update
 * archive. `packageRoot` is the archive-relative root the manifest's archiveRoot
 * is measured from. The message on every failure names the install step that is
 * missing, so a user-facing diagnostic can be shown verbatim.
 */
export function discoverPackagedImage(packageRoot: string, expectations: PackagedHostImageExpectations = {}): PackagedImageDiscovery {
	const parentDir = join(packageRoot, PACKAGED_HOST_IMAGE_PARENT);
	if (!existsSync(parentDir)) {
		return {
			status: "absent",
			reason:
				`this dev3 package has no ${PACKAGED_HOST_IMAGE_PARENT}/ directory (looked in ${parentDir}). ` +
				"Reinstall dev3 from a build that ran `bun run build:native` before packaging; the native terminal host cannot be staged from this package.",
		};
	}
	let tags: string[];
	try {
		tags = readdirSync(parentDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && isValidImageTag(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch (err) {
		return { status: "partial", imageDir: parentDir, reason: `cannot list ${parentDir}: ${String(err)}` };
	}
	if (tags.length === 0) {
		return { status: "absent", reason: `${parentDir} contains no host image directory; the packaged native terminal host is incomplete.` };
	}
	if (tags.length > 1) {
		return { status: "ambiguous", tags, reason: `${parentDir} contains ${tags.length} host images (${tags.join(", ")}); expected exactly one.` };
	}
	const tag = tags[0];
	const imageDir = join(parentDir, tag);
	const read = readPackagedImage(imageDir, { ...expectations, tag });
	if (read.status !== "ok") return { status: "partial", imageDir, reason: read.reason };
	return { status: "ok", tag, imageDir, manifest: read.manifest };
}

export type StagePackagedImageResult =
	| { status: "staged"; tag: string; imageDir: string; entrypointPath: string; runtimeCarrierPath: string; manifest: PackagedHostImageManifest }
	| { status: "already-staged"; tag: string; imageDir: string; entrypointPath: string; runtimeCarrierPath: string; manifest: PackagedHostImageManifest }
	| { status: "failed"; tag: string | null; reason: string };

export interface StagePackagedImageInput {
	/** Image directory to copy from — inside the installed package or an extracted archive. */
	sourceImageDir: string;
	/** Staging root outside the replaceable installation directory. */
	stagingRoot: string;
	expectations?: PackagedHostImageExpectations;
}

/**
 * Copy a validated packaged image into `stagingRoot/<tag>/`, additively.
 *
 * • An already-staged tag is validated and returned untouched — never rewritten,
 *   so a host still running from it keeps its exact bytes.
 * • A fresh copy lands in a dot-prefixed scratch directory (ignored by every
 *   reader) and is only moved into place after it re-validates; a corrupt or
 *   partial copy is removed and reported instead of being made visible.
 */
export function stagePackagedImage(input: StagePackagedImageInput): StagePackagedImageResult {
	const source = readPackagedImage(input.sourceImageDir, input.expectations);
	if (source.status !== "ok") {
		return { status: "failed", tag: null, reason: `source image at ${input.sourceImageDir} is not usable: ${source.reason}` };
	}
	const tag = source.manifest.tag;
	const destination = join(input.stagingRoot, tag);
	const expectations: PackagedHostImageExpectations = { ...input.expectations, tag };

	if (existsSync(destination)) {
		const existing = readPackagedImage(destination, expectations);
		if (existing.status !== "ok") {
			return { status: "failed", tag, reason: `already-staged image ${tag} is unusable and is never overwritten: ${existing.reason}` };
		}
		return { status: "already-staged", ...stagedPaths(destination, existing.manifest), manifest: existing.manifest };
	}

	mkdirSync(input.stagingRoot, { recursive: true, mode: 0o700 });
	const scratchDir = mkdtempSync(join(input.stagingRoot, `.staging-${tag}-`));
	try {
		copyImageFiles(source.imageDir, scratchDir, source.manifest);
		const copied = readPackagedImage(scratchDir, { ...expectations, tag });
		if (copied.status !== "ok") {
			return { status: "failed", tag, reason: `staged copy of ${tag} failed validation: ${copied.reason}` };
		}
		if (existsSync(destination)) {
			// Lost a race with another dev3 process; the winner's image is authoritative.
			const winner = readPackagedImage(destination, expectations);
			if (winner.status !== "ok") return { status: "failed", tag, reason: `concurrently staged image ${tag} is unusable: ${winner.reason}` };
			return { status: "already-staged", ...stagedPaths(destination, winner.manifest), manifest: winner.manifest };
		}
		renameSync(scratchDir, destination);
		const staged = readPackagedImage(destination, expectations);
		if (staged.status !== "ok") return { status: "failed", tag, reason: `staged image ${tag} failed post-move validation: ${staged.reason}` };
		return { status: "staged", ...stagedPaths(destination, staged.manifest), manifest: staged.manifest };
	} catch (err) {
		return { status: "failed", tag, reason: `staging ${tag} failed: ${String(err)}` };
	} finally {
		rmSync(scratchDir, { recursive: true, force: true });
	}
}

function stagedPaths(
	imageDir: string,
	manifest: PackagedHostImageManifest,
): { tag: string; imageDir: string; entrypointPath: string; runtimeCarrierPath: string } {
	return {
		tag: manifest.tag,
		imageDir,
		entrypointPath: join(imageDir, manifest.artifact.entrypoint),
		runtimeCarrierPath: join(imageDir, manifest.runtimeCarrier),
	};
}

function copyImageFiles(sourceDir: string, targetDir: string, manifest: PackagedHostImageManifest): void {
	// Manifest last, mirroring assemble(): a reader that sees the manifest can
	// always find every file it declares.
	for (const entry of manifest.artifact.files) {
		const target = join(targetDir, entry.path);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(sourceDir, entry.path), target);
	}
	copyFileSync(imageManifestPath(sourceDir), imageManifestPath(targetDir));
}

export interface StagedPackagedImageListing {
	ok: Array<{ tag: string; imageDir: string; manifest: PackagedHostImageManifest }>;
	incomplete: Array<{ tag: string; imageDir: string; reason: string }>;
}

/** Classify every staged image under `stagingRoot`. Empty when the root is absent. */
export function listPackagedImages(stagingRoot: string): StagedPackagedImageListing {
	const listing: StagedPackagedImageListing = { ok: [], incomplete: [] };
	let tags: string[];
	try {
		tags = readdirSync(stagingRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && isValidImageTag(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return listing;
	}
	for (const tag of tags) {
		const imageDir = join(stagingRoot, tag);
		const read = readPackagedImage(imageDir, { tag });
		if (read.status === "ok") listing.ok.push({ tag, imageDir, manifest: read.manifest });
		else listing.incomplete.push({ tag, imageDir, reason: read.reason });
	}
	return listing;
}

export type PackagedImageSelection =
	| { status: "selected"; tag: string; imageDir: string; entrypointPath: string; runtimeCarrierPath: string; manifest: PackagedHostImageManifest }
	| { status: "not-found"; reason: string; availableTags: string[]; availableProtocolVersions: number[] }
	| { status: "ambiguous"; reason: string; tags: string[] };

/**
 * Read-only rollback selection: pick an already-staged image by exact tag, or the
 * single image speaking a protocol version. Never guesses a "closest" version,
 * never mutates a manifest, and never touches session state — a caller that gets
 * `not-found` must surface it.
 */
export function selectPackagedImage(stagingRoot: string, criteria: { tag?: string; protocolVersion?: number }): PackagedImageSelection {
	const { ok } = listPackagedImages(stagingRoot);
	const availableTags = ok.map((image) => image.tag);
	const availableProtocolVersions = [...new Set(ok.map((image) => image.manifest.artifact.protocolVersion))].sort((a, b) => a - b);

	const matches =
		criteria.tag !== undefined
			? ok.filter((image) => image.tag === criteria.tag)
			: criteria.protocolVersion !== undefined
				? ok.filter((image) => image.manifest.artifact.protocolVersion === criteria.protocolVersion)
				: [];
	if (criteria.tag === undefined && criteria.protocolVersion === undefined) {
		return { status: "not-found", reason: "selection requires either a tag or a protocol version", availableTags, availableProtocolVersions };
	}
	if (matches.length === 0) {
		const wanted = criteria.tag !== undefined ? `tag ${criteria.tag}` : `protocol version ${criteria.protocolVersion}`;
		return { status: "not-found", reason: `no staged host image matches ${wanted}`, availableTags, availableProtocolVersions };
	}
	if (matches.length > 1) {
		return {
			status: "ambiguous",
			reason: `${matches.length} staged images speak protocol version ${criteria.protocolVersion}; select one by tag`,
			tags: matches.map((image) => image.tag).sort(),
		};
	}
	const image = matches[0];
	return { status: "selected", ...stagedPaths(image.imageDir, image.manifest), manifest: image.manifest };
}

/**
 * Stable content fingerprint of a staged image (sorted filename + bytes). Lets a
 * proof assert an older image was NOT rewritten while a newer one was staged
 * beside it. Returns null when the directory is absent or unreadable.
 */
export function fingerprintPackagedImage(imageDir: string): string | null {
	if (!existsSync(imageDir)) return null;
	const hash = createHash("sha256");
	let names: string[];
	try {
		names = readdirSync(imageDir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return null;
	}
	for (const name of names) {
		hash.update(name).update("\0").update(readFileSync(join(imageDir, name))).update("\0");
	}
	return hash.digest("hex");
}

/** True when `candidate` lives inside `root`. Guards "staged outside the install dir". */
export function isInsideDirectory(root: string, candidate: string): boolean {
	const fromRoot = relative(resolve(root), resolve(candidate));
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

/** Byte size of a file, or null when it is absent / not a regular file. */
export function regularFileSize(path: string): number | null {
	try {
		const stat = lstatSync(path);
		return stat.isFile() ? stat.size : null;
	} catch {
		return null;
	}
}
