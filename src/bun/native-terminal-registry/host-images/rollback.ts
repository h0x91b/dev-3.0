/**
 * Explicit staged-image SELECTION for rollback (seq 1248).
 *
 * Rollback = deliberately booting a NEW session on an OLDER, still-staged host
 * image (e.g. after an update regressed). The selection is intentionally dumb
 * and honest: it returns exactly the image whose protocol version was asked for,
 * or a typed "no compatible image" / "ambiguous" verdict. It NEVER:
 *   • guesses (no "newest", no "closest", no nearest-version fallback),
 *   • mutates any manifest or metadata (read-only over listStagedImages),
 *   • falls back to a legacy terminal backend.
 *
 * A caller that gets `no-compatible-image` must surface it, not paper over it.
 *
 * node:fs-only (via staging.ts) so it is unit-testable under the Bun stub.
 */

import { listStagedImages, type OkImage } from "./staging";

export type ImageSelection =
	| { status: "selected"; protocolVersion: number; tag: string; imageDir: string; entrypointPath: string; image: OkImage }
	| { status: "no-compatible-image"; protocolVersion: number; availableProtocolVersions: number[] }
	| { status: "ambiguous"; protocolVersion: number; tags: string[] };

/**
 * Select the single staged image that speaks `protocolVersion`. Read-only and
 * deterministic: zero matches → `no-compatible-image` (with what IS available,
 * for a diagnostic), exactly one → `selected`, more than one → `ambiguous`
 * (the caller must disambiguate by tag rather than have one silently chosen).
 */
export function selectImageForProtocol(root: string, protocolVersion: number): ImageSelection {
	const { ok } = listStagedImages(root);
	const matches = ok.filter((image) => image.manifest.protocolVersion === protocolVersion);
	if (matches.length === 0) {
		const availableProtocolVersions = [...new Set(ok.map((image) => image.manifest.protocolVersion))].sort((a, b) => a - b);
		return { status: "no-compatible-image", protocolVersion, availableProtocolVersions };
	}
	if (matches.length > 1) {
		return { status: "ambiguous", protocolVersion, tags: matches.map((image) => image.tag).sort() };
	}
	const image = matches[0];
	return {
		status: "selected",
		protocolVersion,
		tag: image.tag,
		imageDir: image.imageDir,
		entrypointPath: image.entrypointPath,
		image,
	};
}

/** Select a staged image by exact tag, honouring the same honest verdicts as by-protocol. */
export function selectImageByTag(root: string, tag: string): ImageSelection | { status: "not-found"; tag: string } {
	const { ok } = listStagedImages(root);
	const image = ok.find((candidate) => candidate.tag === tag);
	if (!image) return { status: "not-found", tag };
	return {
		status: "selected",
		protocolVersion: image.manifest.protocolVersion,
		tag: image.tag,
		imageDir: image.imageDir,
		entrypointPath: image.entrypointPath,
		image,
	};
}
