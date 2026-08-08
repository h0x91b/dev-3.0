/**
 * Update channels: what a channel is, how it is read off disk, and how two builds
 * on the same channel are ordered.
 *
 * TWO CHANNELS, TWO DIFFERENT ORDERINGS, AND THAT IS THE WHOLE POINT OF THIS FILE.
 *
 * `stable` ships only when a release is tagged, so its builds carry distinct semver
 * versions and order by semver. `canary` is published from `main` on a schedule with
 * NO tag, so every one of its builds reports the same `version` as the last release —
 * semver cannot order them, and `isNewerVersion` does not merely fail to help, it
 * actively reports "equal" (see {@link CANARY_VERSION_IS_NOT_ORDERABLE}). Canary
 * therefore orders by {@link UpdateManifest.buildOrder}, a monotonic counter.
 */

/** The channel a user has selected. Persisted in settings.json. */
export type UpdateChannel = "stable" | "canary";

/** New installs and every unrecognised value land here. Nobody opts in by accident. */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "stable";

/**
 * Read a persisted channel value. Anything that is not exactly `"canary"` becomes
 * `"stable"`.
 *
 * THIS FALLBACK IS LOAD-BEARING, not defensive tidiness. `~/.dev3.0/settings.json` is
 * shared by every installed version of the app on the machine, so an N-2 build can read
 * a value written by a newer one — including a channel name it has never heard of. The
 * fallback is what makes that safe: an unknown channel degrades to the one channel every
 * version can serve, rather than pointing the updater at a feed that does not exist for
 * it. It is also what makes the `unstable` → `canary` rename need no migration at all: a
 * value written by v1.42.1 simply stops matching and degrades, in memory, on load.
 */
export function coerceUpdateChannel(value: unknown, canaryAvailable: boolean): UpdateChannel {
	// `canaryAvailable` IS REQUIRED AND HAS NO DEFAULT, on purpose. It is a fact about the
	// HOST — the canary feed carries builds for some platforms and not others — and a default
	// would let a caller that does not know the host silently answer for it. It is also what
	// returns a user who switched on a platform that later has no build: the update check
	// reads this persisted value, not the Settings control, so a disabled select alone would
	// leave them on a channel that answers 403.
	if (!canaryAvailable) return DEFAULT_UPDATE_CHANNEL;
	return value === "canary" ? "canary" : DEFAULT_UPDATE_CHANNEL;
}

/**
 * What one `{channel}-{os}-{arch}-update.json` in the release bucket contains.
 *
 * `sha` and `buildOrder` answer DIFFERENT questions and neither is derivable from the
 * other: `sha` says WHICH COMMIT this build came from (identity — the hourly workflow
 * compares it against `main` to decide whether to build at all), `buildOrder` says WHICH
 * OF TWO BUILDS IS NEWER (ordering — clients compare it to decide whether to update).
 * A re-run on the same commit reproduces both, so it neither reinstalls for clients nor
 * rebuilds for CI; that is what makes the manual dispatch safe to press twice.
 *
 * `create-release-artifacts.sh` writes both on EVERY channel — one code path, no branch
 * to get wrong. Only the canary client logic reads `buildOrder`; stable orders by
 * semver and ignores it. They stay optional here because manifests published before this
 * change do not carry them.
 */
export interface UpdateManifest {
	version: string;
	hash: string;
	/** The commit this build came from. Identity, for the hourly workflow's skip check. */
	sha?: string;
	/**
	 * `git rev-list --count HEAD`. Ordering, read only on the canary channel.
	 *
	 * Monotonic because `main` is SQUASH-MERGED — its history is linear, so the count
	 * rises by exactly one per merge. That is a property of how this repo lands pull
	 * requests, NOT a property of git: allow merge commits onto `main` and the count
	 * still rises but no longer tracks "one per change", and a non-linear history could
	 * make two different builds share a count. If the merge strategy changes, this
	 * ordering has to change with it.
	 */
	buildOrder?: number;
}

/**
 * `isNewerVersion` cannot order two canary builds, and it fails SILENTLY.
 *
 * The canary display version is `1.42.0+canary.<short-sha>`. `isNewerVersion` splits
 * on `.` and runs `Number()` over the parts, so `"0+canary"` becomes `NaN`, then `|| 0`
 * coerces it to `0` — no throw, no warning, and the string parses as a plain `1.42.0`.
 * Two consecutive canary builds therefore compare EQUAL and the routine check would
 * never offer an update: install canary once and sit there until the next stable minor
 * bump. `update-channel.test.ts` pins that behaviour so nobody "fixes" the comparator and
 * silently re-enables the dead path.
 */
export const CANARY_VERSION_IS_NOT_ORDERABLE = true;

/** Build metadata suffix appended to the stable version for DISPLAY on canary. */
export function canaryDisplayVersion(baseVersion: string, shortSha: string): string {
	return `${baseVersion}+canary.${shortSha}`;
}

/**
 * Why an update is (not) on offer. `switch` is deliberately a different kind from
 * `update`: crossing channels may install an OLDER build, and the UI must say which
 * direction it is going rather than calling it an update.
 */
export type UpdateDecision =
	| { kind: "none" }
	| { kind: "update"; version: string }
	| { kind: "switch"; version: string; to: UpdateChannel; installsOlderBuild: boolean }
	| { kind: "error"; reason: string };

export interface LocalBuild {
	/** From the bundle's `version.json`. Never carries the `+canary.<sha>` suffix. */
	version: string;
	hash: string;
	/** The channel baked into the bundle at build time. */
	channel: string;
	/** Baked in by `scripts/generate-build-info.ts`; absent on builds made before it existed. */
	buildOrder?: number;
}

/**
 * Decide what to offer, given the channel the user selected and the manifest fetched from
 * that channel's feed.
 *
 * Three separate rules, and keeping them separate is the design:
 *  - crossing channels → compare HASH, because the target channel's build is simply a
 *    different build and "newer" is not the question being asked;
 *  - staying on stable → compare SEMVER, unchanged from before channels existed;
 *  - staying on canary → compare BUILD ORDER, because semver cannot order it.
 *
 * The hash comparison is confined to the crossing case ON PURPOSE. Leaking it into the
 * routine check would turn every republish of the same commit — a workflow re-run, a
 * manual dispatch on an unchanged `main` — into a pointless download-and-restart.
 */
export function decideUpdate(
	local: LocalBuild,
	selected: UpdateChannel,
	remote: UpdateManifest,
	isNewerSemver: (localVersion: string, remoteVersion: string) => boolean,
): UpdateDecision {
	if (!remote.hash) return { kind: "error", reason: "manifest has no hash" };

	if (local.channel !== selected) {
		if (remote.hash === local.hash) return { kind: "none" };
		return {
			kind: "switch",
			version: remote.version,
			to: selected,
			// Compares the CORE versions, so it is honest even though the canary
			// display version carries a suffix semver ignores.
			installsOlderBuild: isNewerSemver(remote.version, local.version),
		};
	}

	if (selected === "stable") {
		return isNewerSemver(local.version, remote.version)
			? { kind: "update", version: remote.version }
			: { kind: "none" };
	}

	// Canary, same channel. A manifest without buildOrder is malformed rather than
	// "not newer": falling through to a hash or semver comparison here is exactly the
	// silent breakage this whole module exists to prevent, so it is reported instead.
	if (typeof remote.buildOrder !== "number") {
		return { kind: "error", reason: "canary manifest has no buildOrder, so two builds cannot be ordered" };
	}
	if (typeof local.buildOrder !== "number") {
		// A pre-buildOrder canary bundle cannot be compared, but it is definitely not
		// the build the feed is advertising. Offer it; the hash check in the updater
		// still prevents reinstalling the identical bundle.
		return remote.hash === local.hash ? { kind: "none" } : { kind: "update", version: remote.version };
	}
	return remote.buildOrder > local.buildOrder
		? { kind: "update", version: remote.version }
		: { kind: "none" };
}

/**
 * Prefix marking a build that is NOT an ordinary stable install: "[DEV from src]" for
 * `bun run dev`, "[CANARY]" for the canary channel.
 *
 * This is the whole "which build am I on?" affordance, and deliberately so — it costs no
 * chrome, no header slot and no budget, and it is the one cue that survives browser remote
 * mode too, where it becomes the tab title. It keys on the channel baked into the bundle,
 * NEVER on the version string: the `+canary.<sha>` suffix lives only in the published
 * manifest and must never enter the bundle's version.json, because `dev3 doctor` compares
 * the bundle version against the CLI version by string equality.
 */
export function buildChannelTitlePrefix(buildChannel?: string): string {
	if (buildChannel === "dev") return "[DEV from src] ";
	if (buildChannel === "canary") return "[CANARY] ";
	return "";
}
