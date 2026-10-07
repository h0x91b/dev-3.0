/**
 * Which archived release directories in the bucket may expire.
 *
 * Deletion itself is an S3 lifecycle rule (`infra/release-bucket-lifecycle.json`) that expires
 * only objects carrying RETENTION_TAG_KEY. This module decides what gets that tag, and the
 * whole safety model is that the default is "keep": a directory any current manifest or the
 * Homebrew formula still points at is never tagged, however old it is. A bug here can only
 * leave something untagged (pennies of storage), never tag the build users are on.
 */

export const RETENTION_TAG_KEY = "dev3-retention";

/** One tag value per channel, so the lifecycle rules can expire them on different clocks. */
export const RETENTION_TAG = { canary: "superseded-canary", stable: "superseded-stable" } as const;

/** Lifecycle expiry, counted by S3 from each object's creation — not from when it was tagged. */
export const RETENTION_DAYS = { canary: 7, stable: 90 } as const;

/** Newest directories kept regardless of manifests: a second line of defence, not the first. */
export const KEEP_NEWEST = { canary: 10, stable: 3 } as const;

export const RELEASE_PREFIX = "dev-3.0/";

export interface BucketObject {
	key: string;
	size: number;
	lastModified: string;
}

export interface ManifestRef {
	key: string;
	version: string;
	sha: string;
}

export type ArchiveChannel = keyof typeof RETENTION_TAG;

export interface DirVerdict {
	dir: string;
	channel: ArchiveChannel;
	objects: number;
	bytes: number;
	newest: string;
	keep: string | null;
}

export interface RetentionPlan {
	protectedDirs: string[];
	dirs: DirVerdict[];
}

const SHA_DIR = /^[0-9a-f]{40}$/;
const VERSION_DIR = /^v\d+\.\d+\.\d+(?:[-+].*)?$/;

export function archiveChannel(dir: string): ArchiveChannel | null {
	if (SHA_DIR.test(dir)) return "canary";
	if (VERSION_DIR.test(dir)) return "stable";
	return null;
}

/** `1.57.1+canary.e498d788` → `v1.57.1`: the directory a stable release of that version syncs to. */
function versionDir(version: string): string {
	return `v${version.replace(/[+].*$/, "")}`;
}

/**
 * Throws instead of guessing whenever a reference is missing or malformed — an incomplete
 * protected set is the one input that could tag a live build.
 */
export function planRetention(input: {
	objects: BucketObject[];
	manifests: ManifestRef[];
	expectedManifestKeys: string[];
	formulaVersion: string;
}): RetentionPlan {
	const seen = new Set(input.manifests.map((m) => m.key));
	const missing = input.expectedManifestKeys.filter((key) => !seen.has(key));
	if (missing.length > 0) throw new Error(`manifests not read: ${missing.join(", ")}`);
	for (const m of input.manifests) {
		if (!SHA_DIR.test(m.sha)) throw new Error(`${m.key} carries no full commit sha (got "${m.sha}")`);
		if (!/^\d+\.\d+\.\d+/.test(m.version)) throw new Error(`${m.key} carries no version (got "${m.version}")`);
	}
	if (!/^\d+\.\d+\.\d+$/.test(input.formulaVersion)) {
		throw new Error(`Homebrew formula version unreadable (got "${input.formulaVersion}")`);
	}

	const reasons = new Map<string, string>();
	const protect = (dir: string, reason: string) => {
		if (!reasons.has(dir)) reasons.set(dir, reason);
	};
	for (const m of input.manifests) {
		protect(m.sha, `sha in ${m.key}`);
		if (m.key.includes("/stable-")) protect(versionDir(m.version), `version in ${m.key}`);
	}
	protect(versionDir(input.formulaVersion), "Homebrew formula version");

	const grouped = new Map<string, DirVerdict>();
	for (const object of input.objects) {
		if (!object.key.startsWith(RELEASE_PREFIX)) continue;
		const parts = object.key.slice(RELEASE_PREFIX.length).split("/");
		if (parts.length < 2) continue;
		const channel = archiveChannel(parts[0]);
		if (!channel) continue;
		const row = grouped.get(parts[0]) ?? { dir: parts[0], channel, objects: 0, bytes: 0, newest: "", keep: null };
		row.objects += 1;
		row.bytes += object.size;
		if (object.lastModified > row.newest) row.newest = object.lastModified;
		grouped.set(parts[0], row);
	}

	const dirs = [...grouped.values()];
	for (const channel of ["canary", "stable"] as const) {
		dirs
			.filter((d) => d.channel === channel)
			.sort((a, b) => b.newest.localeCompare(a.newest))
			.slice(0, KEEP_NEWEST[channel])
			.forEach((d) => protect(d.dir, `one of the ${KEEP_NEWEST[channel]} newest ${channel} dirs`));
	}
	for (const d of dirs) d.keep = reasons.get(d.dir) ?? null;

	return { protectedDirs: [...reasons.keys()].sort(), dirs: dirs.sort((a, b) => a.dir.localeCompare(b.dir)) };
}
