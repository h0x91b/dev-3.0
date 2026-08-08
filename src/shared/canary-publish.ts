/**
 * Whether the hourly canary publisher has anything to build.
 *
 * The decision is made PER PLATFORM off the manifest already published for that platform,
 * not once for the whole run. A run that publishes three of four platforms then self-heals
 * on the next tick; a single shared decision would skip the fourth forever, because `main`
 * would not have moved.
 *
 * See decisions/2026/08/06/stable-canary-update-channels.md.
 */

/** Every platform the canary channel publishes, in the order the workflow declares them. */
export const CANARY_PLATFORMS = [
	{ os: "macos", arch: "arm64" },
	{ os: "macos", arch: "x64" },
	{ os: "linux", arch: "x64" },
	{ os: "linux", arch: "arm64" },
] as const;

/**
 * What one look at `s3://.../canary-{os}-{arch}-update.json` established.
 *
 * ABSENT IS A CLAIM, NOT A GUESS, and it is why this is a union rather than an HTTP status.
 * An ANONYMOUS GET cannot make that claim about this bucket: it grants no `s3:ListBucket`,
 * so a key that does not exist answers **403 AccessDenied**, byte-identical to a key that
 * exists behind a broken policy. The publisher is therefore probed with the same credentials
 * it publishes with, where a missing key answers a clean 404 and `absent` means absent.
 */
export type FeedProbe =
	/** Proven missing by an authenticated read. The only input that may bootstrap a platform. */
	| { kind: "absent" }
	/** Read back in full. `body` is the raw manifest. */
	| { kind: "present"; body: string }
	/** Neither proven — a permissions problem, an outage, anything. Never treated as absent. */
	| { kind: "undecidable"; detail: string };

export type PublishDecision =
	| { build: true; reason: string }
	| { build: false; reason: string }
	| { error: string };

/**
 * ABSENT means build. UNDECIDABLE means FAIL — and the whole point is that the probe, not
 * this function, is responsible for telling them apart honestly.
 *
 * Mapping an undecidable read to "absent" would sign and notarize a full release every hour
 * forever the moment bucket permissions changed; mapping it to "present" would stop
 * publishing forever. Both are silent. So it fails, naming what it actually saw.
 */
export function decidePlatformPublish(probe: FeedProbe, headSha: string): PublishDecision {
	if (probe.kind === "absent") {
		return { build: true, reason: "no canary manifest has ever been published for this platform" };
	}
	if (probe.kind === "undecidable") {
		return {
			error:
				`the published manifest could not be read, and its absence could NOT be established: ${probe.detail}. This is deliberately NOT treated as "never published" — building on an unproven absence would sign and notarize a full release every hour for as long as the condition lasts. Fix: read the error above; if it is an access failure, the publishing credentials need s3:ListBucket on h0x91b-releases so a missing key answers 404 instead of 403.`,
		};
	}

	let published: { sha?: unknown };
	try {
		published = JSON.parse(probe.body) as { sha?: unknown };
	} catch {
		return {
			error: `the published manifest was read but is not valid JSON, so the last published commit cannot be determined. Fix: inspect the object in the bucket — a truncated manifest means a previous publish died mid-upload.`,
		};
	}

	if (typeof published.sha !== "string" || !published.sha) {
		// Written before the `sha` field existed, or by something that is not our script.
		// Cannot be compared, so it cannot be trusted as current — build once, after which
		// the field is there.
		return { build: true, reason: "the published manifest carries no sha, so it cannot be compared" };
	}
	if (published.sha === headSha) {
		return { build: false, reason: `already published at ${headSha.slice(0, 9)}` };
	}
	return { build: true, reason: `published ${published.sha.slice(0, 9)}, main is at ${headSha.slice(0, 9)}` };
}

/**
 * Whether the canary feed carries a build for this host — DERIVED FROM {@link CANARY_PLATFORMS},
 * the same list that drives publishing, so the two cannot drift.
 *
 * WHY NOT PROBE THE BUCKET AT RUNTIME: an anonymous GET cannot tell "no build for this
 * platform" from "no permission" on `h0x91b-releases` — a missing key answers 403, which is
 * how the publisher's own bootstrap deadlocked. A client asking that question would have to
 * guess, and guessing wrong either hides a working channel or offers a broken one.
 *
 * WHY NOT A SECOND LIST: adding `win-x64` to publishing must be the ONLY edit needed to make
 * the channel selectable on Windows. A hand-maintained copy here would be a second place to
 * remember, and it is precisely the place nobody would think to look.
 */
export function canaryPublishesFor(os: string, arch: string): boolean {
	return CANARY_PLATFORMS.some((p) => p.os === os && p.arch === arch);
}

/** Node's `process.platform` in the spelling {@link CANARY_PLATFORMS} uses. Unknown stays unknown. */
export function hostOsName(platform: string): string {
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "win";
	if (platform === "linux") return "linux";
	return platform;
}
