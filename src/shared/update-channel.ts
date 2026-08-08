/**
 * Update channels: what a channel is, how it is read off disk, and how two builds
 * on the same channel are ordered.
 *
 * TWO CHANNELS, TWO DIFFERENT ORDERINGS, AND THAT IS THE WHOLE POINT OF THIS FILE.
 *
 * `stable` ships only when a release is tagged, so its builds carry distinct semver
 * versions and order by semver. `unstable` is published from `main` on a schedule with
 * NO tag, so every one of its builds reports the same `version` as the last release —
 * semver cannot order them, and `isNewerVersion` does not merely fail to help, it
 * actively reports "equal" (see {@link UNSTABLE_VERSION_IS_NOT_ORDERABLE}). Unstable
 * therefore orders by {@link UpdateManifest.buildOrder}, a monotonic counter.
 */

/** The channel a user has selected. Persisted in settings.json. */
export type UpdateChannel = "stable" | "unstable";

/** New installs and every unrecognised value land here. Nobody opts in by accident. */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "stable";

/**
 * FALSE, because nothing is published under `unstable-*` and nothing can be yet.
 *
 * `electrobun build --env=unstable` cannot produce an unstable build: the CLI that actually
 * runs is a compiled binary the vendor's `bin/electrobun.cjs` downloads (`ensureCliBinary()`),
 * while `patches/electrobun@*.patch` edits `src/cli/index.ts`, which that path never
 * executes — so `--env` hits the vendor's allowlist and degrades to `dev`. v1.42.1 shipped
 * the control live regardless, so a macOS user who picks Unstable gets a bare
 * `HTTP 403 fetching update.json` and stays in it until they switch back.
 *
 * TWO THINGS HANG OFF THIS FLAG, and the second is the one that is easy to omit:
 *  1. the Settings control is disabled — that protects whoever has NOT switched yet;
 *  2. {@link coerceUpdateChannel} collapses to stable — the ONLY thing that helps whoever
 *     ALREADY switched. The control is UI, but the update check reads the persisted
 *     setting directly, so disabling the select alone would ship a fix that does nothing
 *     for the single person it exists for.
 *
 * The collapse happens in memory, on load. Nothing under `~/.dev3.0/` is rewritten, so an
 * older installed build reading the same file still finds the value it wrote.
 *
 * DELETE THIS CONSTANT — do not flip it to `true` — in the change that gives the second
 * channel a build path PROVEN to emit its artifacts. A permanently-true constant is a dead
 * branch whose guard tests then assert nothing.
 */
export const UNSTABLE_FEED_AVAILABLE = false;

/**
 * Read a persisted channel value. Anything that is not exactly `"unstable"` becomes
 * `"stable"`.
 *
 * THIS FALLBACK IS LOAD-BEARING, not defensive tidiness. `~/.dev3.0/settings.json` is
 * shared by every installed version of the app on the machine, so an N-2 build can read
 * a value written by a newer one — including a channel name it has never heard of. The
 * fallback is what makes that safe: an unknown channel degrades to the one channel every
 * version can serve, rather than pointing the updater at a feed that does not exist for
 * it. It is also what let the old `"canary"` value be removed outright instead of kept
 * as a compatibility alias.
 */
export function coerceUpdateChannel(value: unknown): UpdateChannel {
	// While the second channel has no feed, a value already persisted by v1.42.1 must
	// collapse too — see {@link UNSTABLE_FEED_AVAILABLE}. Disabling the control alone
	// leaves the one user who already switched exactly where they were.
	if (!UNSTABLE_FEED_AVAILABLE) return DEFAULT_UPDATE_CHANNEL;
	return value === "unstable" ? "unstable" : DEFAULT_UPDATE_CHANNEL;
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
 * to get wrong. Only the unstable client logic reads `buildOrder`; stable orders by
 * semver and ignores it. They stay optional here because manifests published before this
 * change do not carry them.
 */
export interface UpdateManifest {
	version: string;
	hash: string;
	/** The commit this build came from. Identity, for the hourly workflow's skip check. */
	sha?: string;
	/**
	 * `git rev-list --count HEAD`. Ordering, read only on the unstable channel.
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
 * `isNewerVersion` cannot order two unstable builds, and it fails SILENTLY.
 *
 * The unstable display version is `1.42.0+unstable.<short-sha>`. `isNewerVersion` splits
 * on `.` and runs `Number()` over the parts, so `"0+unstable"` becomes `NaN`, then `|| 0`
 * coerces it to `0` — no throw, no warning, and the string parses as a plain `1.42.0`.
 * Two consecutive unstable builds therefore compare EQUAL and the routine check would
 * never offer an update: install unstable once and sit there until the next stable minor
 * bump. `update-channel.test.ts` pins that behaviour so nobody "fixes" the comparator and
 * silently re-enables the dead path.
 */
export const UNSTABLE_VERSION_IS_NOT_ORDERABLE = true;

/** Build metadata suffix appended to the stable version for DISPLAY on unstable. */
export function unstableDisplayVersion(baseVersion: string, shortSha: string): string {
	return `${baseVersion}+unstable.${shortSha}`;
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
	/** From the bundle's `version.json`. Never carries the `+unstable.<sha>` suffix. */
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
 *  - staying on unstable → compare BUILD ORDER, because semver cannot order it.
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
			// Compares the CORE versions, so it is honest even though the unstable
			// display version carries a suffix semver ignores.
			installsOlderBuild: isNewerSemver(remote.version, local.version),
		};
	}

	if (selected === "stable") {
		return isNewerSemver(local.version, remote.version)
			? { kind: "update", version: remote.version }
			: { kind: "none" };
	}

	// Unstable, same channel. A manifest without buildOrder is malformed rather than
	// "not newer": falling through to a hash or semver comparison here is exactly the
	// silent breakage this whole module exists to prevent, so it is reported instead.
	if (typeof remote.buildOrder !== "number") {
		return { kind: "error", reason: "unstable manifest has no buildOrder, so two builds cannot be ordered" };
	}
	if (typeof local.buildOrder !== "number") {
		// A pre-buildOrder unstable bundle cannot be compared, but it is definitely not
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
 * `bun run dev`, "[UNSTABLE]" for the unstable channel.
 *
 * This is the whole "which build am I on?" affordance, and deliberately so — it costs no
 * chrome, no header slot and no budget, and it is the one cue that survives browser remote
 * mode too, where it becomes the tab title. It keys on the channel baked into the bundle,
 * NEVER on the version string: the `+unstable.<sha>` suffix lives only in the published
 * manifest and must never enter the bundle's version.json, because `dev3 doctor` compares
 * the bundle version against the CLI version by string equality.
 */
export function buildChannelTitlePrefix(buildChannel?: string): string {
	if (buildChannel === "dev") return "[DEV from src] ";
	if (buildChannel === "unstable") return "[UNSTABLE] ";
	return "";
}
