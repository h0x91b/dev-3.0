import type { SharedArtifact, SharedArtifactVersion } from "./types";

/**
 * Versions kept per artifact. Older ones are pruned from the record AND from
 * disk: the `shared-artifacts/` dirs live next to the worktrees and outlive
 * them, so an uncapped history would grow forever. The viewer states how many
 * versions were dropped instead of losing them silently.
 */
export const MAX_ARTIFACT_VERSIONS = 20;

/** Grouping key from an explicit slug, else the normalized title. */
export function artifactGroupKey(input: { artifactId?: string; title: string }): string {
	const slug = input.artifactId?.trim().toLowerCase();
	if (slug) return `id:${slug}`;
	return `title:${input.title.trim().replace(/\s+/g, " ").toLowerCase()}`;
}

/** The key a record groups under — legacy records fall back to their title. */
export function recordGroupKey(artifact: SharedArtifact): string {
	return artifact.groupKey ?? artifactGroupKey({ title: artifact.title });
}

/** Version number of the record itself; a legacy record is version 1. */
export function latestArtifactVersion(artifact: SharedArtifact): number {
	return artifact.version ?? 1;
}

function ownVersion(artifact: SharedArtifact): SharedArtifactVersion {
	return {
		version: latestArtifactVersion(artifact),
		name: artifact.name,
		storedPath: artifact.storedPath,
		originalPath: artifact.originalPath,
		bytes: artifact.bytes,
		createdAt: artifact.createdAt,
		assets: artifact.assets,
		bundlePath: artifact.bundlePath,
		bundleBytes: artifact.bundleBytes,
	};
}

/** Every retained version, oldest → newest. The record itself is the newest. */
export function artifactVersions(artifact: SharedArtifact): SharedArtifactVersion[] {
	return [...(artifact.previousVersions ?? []), ownVersion(artifact)];
}

/** How many versions the retention cap removed — derived, never stored. */
export function droppedArtifactVersions(artifact: SharedArtifact): number {
	return Math.max(0, latestArtifactVersion(artifact) - artifactVersions(artifact).length);
}

/**
 * The record as it looked at one version, for handing to the storage RPCs.
 * The latest version is the record itself; an older one replaces every
 * per-publish field so nothing from the newer version leaks through.
 */
export function artifactAtVersion(artifact: SharedArtifact, version: number): SharedArtifact {
	if (version === latestArtifactVersion(artifact)) return artifact;
	const found = (artifact.previousVersions ?? []).find((entry) => entry.version === version);
	if (!found) return artifact;
	return {
		...artifact,
		name: found.name,
		storedPath: found.storedPath,
		originalPath: found.originalPath,
		bytes: found.bytes,
		createdAt: found.createdAt,
		assets: found.assets,
		bundlePath: found.bundlePath,
		bundleBytes: found.bundleBytes,
		version: found.version,
		previousVersions: undefined,
	};
}

/**
 * Fold a fresh publish into the task's artifact list.
 *
 * Records sharing the incoming key — including legacy ones grouped by title —
 * collapse into a single artifact at the FIRST matching position, so a row the
 * user already knows does not jump. Versions are renumbered 1..N because each
 * legacy record claims version 1, then trimmed to `cap`.
 */
export function appendArtifactVersion(
	existing: SharedArtifact[],
	incoming: SharedArtifact,
	cap = MAX_ARTIFACT_VERSIONS,
): { artifacts: SharedArtifact[]; pruned: SharedArtifactVersion[] } {
	const key = recordGroupKey(incoming);
	const matches = existing.filter((artifact) => recordGroupKey(artifact) === key);
	if (matches.length === 0) return { artifacts: [...existing, incoming], pruned: [] };

	const target = matches[0];
	const stacked = [...matches.flatMap(artifactVersions), ownVersion(incoming)];
	// Number BACKWARDS from the new latest, never forwards from 1: once the cap has
	// trimmed history, counting the retained entries would walk the publish number
	// back down. The new latest is one past the highest number any matched record
	// claims, or the stack height when collapsing pre-versioning records that each
	// claim version 1.
	const nextLatest = Math.max(
		Math.max(...matches.map(latestArtifactVersion)) + 1,
		stacked.length,
	);
	const history = stacked.map((entry, index) => ({
		...entry,
		version: nextLatest - (stacked.length - 1 - index),
	}));
	const kept = history.slice(Math.max(0, history.length - cap));
	const pruned = history.slice(0, history.length - kept.length);
	const latest = kept[kept.length - 1];

	const merged: SharedArtifact = {
		...incoming,
		id: target.id,
		groupKey: key,
		isUnread: true,
		version: latest.version,
		previousVersions: kept.slice(0, -1),
	};
	return {
		artifacts: existing.filter((artifact) => artifact === target || recordGroupKey(artifact) !== key)
			.map((artifact) => (artifact === target ? merged : artifact)),
		pruned,
	};
}
