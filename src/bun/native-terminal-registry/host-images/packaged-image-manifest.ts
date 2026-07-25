/**
 * MERGED manifest for a packaged native terminal host image (RUN-006 / WIN-004).
 *
 * It merges the two manifest layers that existed separately:
 *   • the immutable image identity of image-manifest.ts (tag, protocol version,
 *     entrypoint, runtime floor), and
 *   • the deterministic file table of artifact-manifest.ts (per-file size +
 *     SHA-256, Bun version, OS/arch),
 * and adds the one fact only packaging knows: `archiveRoot`, the POSIX path the
 * image occupies inside the shipped update archive.
 *
 * A packaged host image is IMMUTABLE. Its tag is derived from its own content,
 * so a rebuilt-but-identical image gets the same tag and a changed one gets a
 * new tag — never an in-place rewrite. No clock is read, so two builds of the
 * same bytes produce byte-identical manifests.
 *
 * Pure node:* only (via artifact-manifest.ts), so it is unit-testable under the
 * vitest Bun stub and usable from a build script.
 */

import { createHash } from "node:crypto";
import {
	generateManifest,
	ManifestError,
	parseManifest,
	serializeManifest,
	validateManifest,
	type ManifestArch,
	type ManifestMetadata,
	type ManifestOs,
	type NativeHostManifest,
} from "./artifact-manifest";
import { isValidImageTag } from "./image-manifest";
import { nativeTerminalRuntimeAtLeast } from "../../../shared/native-terminal-runtime";

/** Frozen merged-manifest schema version. A breaking change bumps this explicitly. */
export const PACKAGED_HOST_IMAGE_SCHEMA_VERSION = 1 as const;

/** Manifest filename inside a packaged host image directory. */
export const PACKAGED_HOST_IMAGE_MANIFEST_FILE = "host-image.json";

export interface PackagedHostImageManifest {
	imageSchemaVersion: typeof PACKAGED_HOST_IMAGE_SCHEMA_VERSION;
	/** Content-derived, immutable image id — also its on-disk directory name. */
	tag: string;
	/** Minimum Bun runtime this image may be launched with; never auto-relaxed. */
	runtimeFloor: string;
	/** POSIX path, inside the image, of the Bun runtime carrier that launches the entrypoint. */
	runtimeCarrier: string;
	/** POSIX path of this image directory relative to the update archive root. */
	archiveRoot: string;
	/** Deterministic file table + build metadata for the image directory itself. */
	artifact: NativeHostManifest;
}

export interface BuildPackagedHostImageManifestInput {
	/** Directory holding the image files (the eventual `<tag>` directory, or a staging copy of it). */
	imageRoot: string;
	/** Launch entrypoint, relative to the image root. */
	entrypoint: string;
	/** Bun runtime carrier, relative to the image root. */
	runtimeCarrier: string;
	/** Declared files, relative to the image root (order-insensitive). */
	files: string[];
	metadata: ManifestMetadata;
	runtimeFloor: string;
	/** POSIX parent path of the image inside the archive, e.g. `native-host-image`. */
	archiveParent: string;
	/** Overrides the content-derived tag; only for fixtures that need a fixed name. */
	tag?: string;
}

function posixJoin(parent: string, child: string): string {
	const cleanParent = parent.replace(/[\\/]+$/, "");
	return cleanParent.length === 0 ? child : `${cleanParent}/${child}`;
}

/**
 * Content-derived tag: `<bunVersion>-p<protocolVersion>-<digest12>`, where the
 * digest covers the serialized artifact manifest plus the runtime floor and
 * carrier. Identical bytes and metadata always yield the identical tag.
 */
export function packagedHostImageTag(artifact: NativeHostManifest, runtimeFloor: string, runtimeCarrier: string): string {
	const digest = createHash("sha256")
		.update(serializeManifest(artifact))
		.update("\0")
		.update(runtimeFloor)
		.update("\0")
		.update(runtimeCarrier)
		.digest("hex")
		.slice(0, 12);
	const tag = `${artifact.bunVersion}-p${artifact.protocolVersion}-${digest}`;
	if (!isValidImageTag(tag)) {
		throw new ManifestError("invalid-tag", `derived image tag ${JSON.stringify(tag)} is not a safe directory segment`, { path: tag });
	}
	return tag;
}

/** Build the merged manifest for an assembled image directory. */
export function buildPackagedHostImageManifest(input: BuildPackagedHostImageManifestInput): PackagedHostImageManifest {
	if (typeof input.runtimeFloor !== "string" || input.runtimeFloor.trim().length === 0) {
		throw new ManifestError("invalid-metadata", "invalid build metadata: runtimeFloor", { paths: ["runtimeFloor"] });
	}
	const artifact = generateManifest({
		artifactRoot: input.imageRoot,
		entrypoint: input.entrypoint,
		files: input.files,
		metadata: input.metadata,
	});
	assertDeclaredRuntimeCarrier(artifact, input.runtimeCarrier);
	assertRuntimeFloor(artifact.bunVersion, input.runtimeFloor);

	const tag = input.tag ?? packagedHostImageTag(artifact, input.runtimeFloor, input.runtimeCarrier);
	if (!isValidImageTag(tag)) {
		throw new ManifestError("invalid-tag", `image tag ${JSON.stringify(tag)} is not a safe directory segment`, { path: tag });
	}
	return {
		imageSchemaVersion: PACKAGED_HOST_IMAGE_SCHEMA_VERSION,
		tag,
		runtimeFloor: input.runtimeFloor,
		runtimeCarrier: input.runtimeCarrier,
		archiveRoot: posixJoin(input.archiveParent, tag),
		artifact,
	};
}

function assertDeclaredRuntimeCarrier(artifact: NativeHostManifest, runtimeCarrier: string): void {
	if (typeof runtimeCarrier !== "string" || !artifact.files.some((entry) => entry.path === runtimeCarrier)) {
		throw new ManifestError("invalid-runtime-carrier", `runtime carrier ${JSON.stringify(runtimeCarrier)} is not among the declared files`, {
			path: String(runtimeCarrier),
		});
	}
	if (runtimeCarrier === artifact.entrypoint) {
		throw new ManifestError("invalid-runtime-carrier", "runtime carrier and entrypoint must be distinct files", { path: runtimeCarrier });
	}
}

function assertRuntimeFloor(bunVersion: string, runtimeFloor: string): void {
	if (!nativeTerminalRuntimeAtLeast(bunVersion, runtimeFloor)) {
		throw new ManifestError("runtime-floor", `packaged Bun ${bunVersion} is below the image runtime floor ${runtimeFloor}`, {
			expected: runtimeFloor,
			actual: bunVersion,
		});
	}
}

/** Byte-stable JSON: fixed key order, sorted files, trailing newline, no clock. */
export function serializePackagedHostImageManifest(manifest: PackagedHostImageManifest): string {
	return `${JSON.stringify(
		{
			imageSchemaVersion: manifest.imageSchemaVersion,
			tag: manifest.tag,
			runtimeFloor: manifest.runtimeFloor,
			runtimeCarrier: manifest.runtimeCarrier,
			archiveRoot: manifest.archiveRoot,
			artifact: JSON.parse(serializeManifest(manifest.artifact)),
		},
		null,
		2,
	)}\n`;
}

/** Strictly parse a merged manifest, or throw `incompatible-schema`. */
export function parsePackagedHostImageManifest(raw: unknown): PackagedHostImageManifest {
	const source = typeof raw === "string" ? safeParseJson(raw) : raw;
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		throw new ManifestError("incompatible-schema", "packaged host image manifest is not a JSON object");
	}
	const m = source as Record<string, unknown>;
	if (m.imageSchemaVersion !== PACKAGED_HOST_IMAGE_SCHEMA_VERSION) {
		throw new ManifestError(
			"incompatible-schema",
			`packaged host image schema version ${JSON.stringify(m.imageSchemaVersion)} is not supported`,
			{ expected: String(PACKAGED_HOST_IMAGE_SCHEMA_VERSION), actual: String(m.imageSchemaVersion) },
		);
	}
	if (
		typeof m.tag !== "string" ||
		typeof m.runtimeFloor !== "string" ||
		typeof m.runtimeCarrier !== "string" ||
		typeof m.archiveRoot !== "string"
	) {
		throw new ManifestError("incompatible-schema", "packaged host image manifest is missing or has malformed required fields");
	}
	return {
		imageSchemaVersion: PACKAGED_HOST_IMAGE_SCHEMA_VERSION,
		tag: m.tag,
		runtimeFloor: m.runtimeFloor,
		runtimeCarrier: m.runtimeCarrier,
		archiveRoot: m.archiveRoot,
		artifact: parseManifest(m.artifact),
	};
}

function safeParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new ManifestError("incompatible-schema", "packaged host image manifest is not valid JSON");
	}
}

export interface PackagedHostImageExpectations {
	os?: ManifestOs;
	arch?: ManifestArch;
	bunVersion?: string;
	protocolVersion?: number;
	tag?: string;
	/** POSIX parent path the image must sit under inside the archive. */
	archiveParent?: string;
}

/**
 * Re-verify a merged manifest against the image directory on disk: every
 * declared file's size + SHA-256, the entrypoint, the runtime carrier, the
 * runtime floor, the tag shape, the archive path, and any caller expectation
 * (OS/arch/Bun/protocol/tag). Returns the parsed manifest on success.
 */
export function validatePackagedHostImageManifest(
	raw: unknown,
	imageRoot: string,
	expectations: PackagedHostImageExpectations = {},
): PackagedHostImageManifest {
	const manifest = parsePackagedHostImageManifest(raw);
	if (!isValidImageTag(manifest.tag)) {
		throw new ManifestError("invalid-tag", `image tag ${JSON.stringify(manifest.tag)} is not a safe directory segment`, { path: manifest.tag });
	}
	const artifact = validateManifest(manifest.artifact, imageRoot);
	assertDeclaredRuntimeCarrier(artifact, manifest.runtimeCarrier);
	assertRuntimeFloor(artifact.bunVersion, manifest.runtimeFloor);

	const archiveSegments = manifest.archiveRoot.split("/");
	if (archiveSegments[archiveSegments.length - 1] !== manifest.tag || archiveSegments.includes("..") || archiveSegments.some((segment) => segment.length === 0)) {
		throw new ManifestError("invalid-archive-root", `archive root ${JSON.stringify(manifest.archiveRoot)} does not end in the image tag`, {
			path: manifest.archiveRoot,
			expected: manifest.tag,
		});
	}

	expectExact("os", artifact.os, expectations.os);
	expectExact("arch", artifact.arch, expectations.arch);
	expectExact("bunVersion", artifact.bunVersion, expectations.bunVersion);
	expectExact("protocolVersion", artifact.protocolVersion, expectations.protocolVersion);
	expectExact("tag", manifest.tag, expectations.tag);
	if (expectations.archiveParent !== undefined) {
		const expectedRoot = posixJoin(expectations.archiveParent, manifest.tag);
		if (manifest.archiveRoot !== expectedRoot) {
			throw new ManifestError("invalid-archive-root", `image declares archive root ${manifest.archiveRoot}, expected ${expectedRoot}`, {
				path: manifest.archiveRoot,
				expected: expectedRoot,
				actual: manifest.archiveRoot,
			});
		}
	}
	return { ...manifest, artifact };
}

function expectExact(field: string, actual: unknown, expected: unknown): void {
	if (expected === undefined || actual === expected) return;
	throw new ManifestError("unexpected-target", `packaged host image ${field} is ${String(actual)}, expected ${String(expected)}`, {
		path: field,
		expected: String(expected),
		actual: String(actual),
	});
}
