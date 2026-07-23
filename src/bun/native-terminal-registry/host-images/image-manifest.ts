/**
 * Immutable staged-host-image MANIFEST (seq 1248, version-skew slice of 1141).
 *
 * A staged host image is the versioned, IMMUTABLE launch artifact an app update
 * installs. Its manifest pins the protocol version the host speaks plus the
 * entrypoint file inside the image directory. Once staged, a manifest is never
 * rewritten — a newer app stages a NEW image beside the old one, and existing
 * sessions keep running on their original image (see README + decision record).
 *
 * Pure module: only JSON, so the parse/serialize contract is unit-testable and
 * carries no Bun/Node runtime dependency. Mirrors the record.ts discipline —
 * parseManifest returns null for any non-current schema (unreadable-and-not-ours,
 * never migrated), keeping the on-disk layout forward/backward compatible.
 */

/** Frozen manifest schema version. A breaking change bumps this and is handled explicitly. */
export const HOST_IMAGE_SCHEMA_VERSION = 1 as const;

export interface StagedHostImageManifest {
	imageSchemaVersion: typeof HOST_IMAGE_SCHEMA_VERSION;
	/** Stable, immutable image id (also its on-disk directory name). */
	tag: string;
	/** The native-session protocol version a host booted from this image speaks. */
	protocolVersion: number;
	hostArtifactVersion: string;
	/** Entrypoint filename INSIDE the image directory (the immutable launch shim). */
	entrypoint: string;
	/** Minimum Bun runtime this image requires; honest gate, never auto-relaxed. */
	runtimeFloor: string;
	stagedAt: string;
}

export function serializeManifest(manifest: StagedHostImageManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parse + strictly validate a manifest, or null if unreadable / not this schema. */
export function parseManifest(text: string): StagedHostImageManifest | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const m = raw as Record<string, unknown>;
	if (m.imageSchemaVersion !== HOST_IMAGE_SCHEMA_VERSION) return null;
	if (
		typeof m.tag !== "string" ||
		typeof m.protocolVersion !== "number" ||
		!Number.isInteger(m.protocolVersion) ||
		m.protocolVersion <= 0 ||
		typeof m.hostArtifactVersion !== "string" ||
		typeof m.entrypoint !== "string" ||
		m.entrypoint.length === 0 ||
		typeof m.runtimeFloor !== "string" ||
		typeof m.stagedAt !== "string"
	) {
		return null;
	}
	return {
		imageSchemaVersion: HOST_IMAGE_SCHEMA_VERSION,
		tag: m.tag,
		protocolVersion: m.protocolVersion,
		hostArtifactVersion: m.hostArtifactVersion,
		entrypoint: m.entrypoint,
		runtimeFloor: m.runtimeFloor,
		stagedAt: m.stagedAt,
	};
}

// Image tags map to a single safe directory segment — no separators, traversal,
// or leading dot (same discipline as native-session ids).
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidImageTag(tag: string): boolean {
	return typeof tag === "string" && IMAGE_TAG_PATTERN.test(tag) && !tag.includes("..");
}

export function assertValidImageTag(tag: string): void {
	if (!isValidImageTag(tag)) {
		throw new Error(`invalid staged host image tag ${JSON.stringify(tag)} — allowed: ${IMAGE_TAG_PATTERN.source} and no "..".`);
	}
}
