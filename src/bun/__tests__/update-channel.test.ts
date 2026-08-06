/**
 * Tripwires for the two-channel update logic.
 *
 * Every assertion here exists because the thing it pins FAILS SILENTLY when broken: the
 * settings coercion degrades an unknown channel instead of crashing, the semver comparator
 * swallows build metadata instead of throwing, and a wrong ordering rule reports "no
 * update" rather than an error. None of them produce a stack trace, so none of them would
 * be noticed without a test. See decisions/2026/08/06/stable-unstable-update-channels.md.
 */

import { describe, expect, it } from "vitest";
import { isNewerVersion } from "../../shared/version";
import {
	buildChannelTitlePrefix,
	coerceUpdateChannel,
	decideUpdate,
	DEFAULT_UPDATE_CHANNEL,
	unstableDisplayVersion,
	type LocalBuild,
	type UpdateManifest,
} from "../../shared/update-channel";

const stableBundle: LocalBuild = { version: "1.42.0", hash: "hash-stable", channel: "stable", buildOrder: 1580 };
const unstableBundle: LocalBuild = { version: "1.42.0", hash: "hash-unstable", channel: "unstable", buildOrder: 1580 };

describe("the persisted channel value", () => {
	it("defaults to stable, so nobody is opted into unstable by accident", () => {
		expect(DEFAULT_UPDATE_CHANNEL).toBe("stable");
	});

	it("degrades every unrecognised value to stable, which is what makes the rename safe", () => {
		// LOAD-BEARING, not tidiness. ~/.dev3.0/settings.json is shared by every installed
		// version on the machine, so an N-2 build can read a channel name it has never
		// heard of. Degrading to stable is what lets the old "canary" value be deleted
		// outright instead of kept as a compatibility alias — and what stops an old build
		// aiming its updater at a feed that does not exist for it.
		for (const rejected of ["canary", "beta", "dev", "STABLE", "Unstable", "", null, undefined, 7, {}]) {
			expect(
				coerceUpdateChannel(rejected),
				`coerceUpdateChannel(${JSON.stringify(rejected)}) must fall back to "stable". An unrecognised channel that survives points the updater at a feed with no manifest, which returns 403 and reads to the user as "you are up to date" forever. Fix: keep the exact-match check in src/shared/update-channel.ts.`,
			).toBe("stable");
		}
	});

	it("accepts exactly the one opt-in spelling", () => {
		expect(coerceUpdateChannel("unstable")).toBe("unstable");
	});
});

describe("the unstable version string carries no ordering", () => {
	// This is WHY unstable needs buildOrder at all. If someone "fixes" isNewerVersion to
	// understand build metadata, they re-enable a path that cannot work, so the broken
	// behaviour is pinned here deliberately rather than treated as a latent bug.
	it("parses the +unstable.<sha> suffix away instead of rejecting it", () => {
		// "0+unstable" -> Number() -> NaN -> `|| 0` -> 0, so this reads as a plain 1.42.0.
		expect(
			isNewerVersion("1.42.0", unstableDisplayVersion("1.42.0", "abc1234")),
			"isNewerVersion must keep reporting `false` here. It splits on `.` and Numbers each part, so the suffix becomes NaN and coerces to 0 — the string parses as a plain 1.42.0 with no throw and no warning. If this now passes, the comparator was changed to understand build metadata, and the unstable channel must be re-checked: it orders by buildOrder precisely because this comparison is meaningless.",
		).toBe(false);
	});

	it("cannot tell two unstable builds apart at all", () => {
		expect(
			isNewerVersion(unstableDisplayVersion("1.42.0", "abc1234"), unstableDisplayVersion("1.42.0", "def5678")),
			"two different unstable builds must still compare as equal here. That equality is the whole reason unstable orders by buildOrder: routing unstable through semver would report `no update` forever — install once, then sit there until the next stable minor bump.",
		).toBe(false);
	});
});

describe("staying on stable orders by semver", () => {
	it("offers a newer tagged release", () => {
		const remote: UpdateManifest = { version: "1.43.0", hash: "hash-next" };
		expect(decideUpdate(stableBundle, "stable", remote, isNewerVersion)).toEqual({
			kind: "update",
			version: "1.43.0",
		});
	});

	it("offers nothing when the feed republishes the same version with a new hash", () => {
		// A rebuild of the same release changes the hash but not the version. Ordering by
		// hash here would reinstall the app for no reason.
		const remote: UpdateManifest = { version: "1.42.0", hash: "hash-rebuilt" };
		expect(
			decideUpdate(stableBundle, "stable", remote, isNewerVersion),
			"stable must ignore a hash change at the same version. If this offers an update, the hash comparison leaked out of the channel-switch path and every republish now costs users a download and a restart.",
		).toEqual({ kind: "none" });
	});
});

describe("staying on unstable orders by the monotonic build counter", () => {
	it("offers a build with a higher counter", () => {
		const remote: UpdateManifest = { version: "1.42.0", hash: "hash-newer", sha: "deadbee", buildOrder: 1581 };
		expect(decideUpdate(unstableBundle, "unstable", remote, isNewerVersion)).toEqual({
			kind: "update",
			version: "1.42.0",
		});
	});

	it("offers nothing when the same commit is republished, so a re-run is not a reinstall", () => {
		// The manual dispatch exists to be pressed on an unchanged main. A new hash with the
		// same counter is exactly that case, and it must be a no-op for clients.
		const remote: UpdateManifest = { version: "1.42.0", hash: "hash-rebuilt", sha: "deadbee", buildOrder: 1580 };
		expect(
			decideUpdate(unstableBundle, "unstable", remote, isNewerVersion),
			"a republish of the same commit must offer nothing. buildOrder is reproducible from the commit, so an equal counter means the same source — if this offers an update, pressing the manual dispatch twice costs every unstable user a download and a restart.",
		).toEqual({ kind: "none" });
	});

	it("never offers a build with a LOWER counter", () => {
		const remote: UpdateManifest = { version: "1.42.0", hash: "hash-older", sha: "cafe123", buildOrder: 1579 };
		expect(decideUpdate(unstableBundle, "unstable", remote, isNewerVersion)).toEqual({ kind: "none" });
	});

	it("reports an error rather than guessing when the manifest has no counter", () => {
		// Falling back to semver or hash here is the silent breakage this module exists to
		// prevent: semver would say "no update" forever, hash would reinstall on republish.
		const remote: UpdateManifest = { version: "1.42.0", hash: "hash-newer" };
		const decision = decideUpdate(unstableBundle, "unstable", remote, isNewerVersion);
		expect(
			decision.kind,
			"an unstable manifest with no buildOrder must be an ERROR, not `none` and not a fallback comparison. A fallback would be invisible: semver reports no-update forever, hash reinstalls on every republish. Fix: publish buildOrder from create-release-artifacts.sh.",
		).toBe("error");
	});
});

describe("crossing channels states a direction, never an update", () => {
	it("offers the target channel's build when the hashes differ", () => {
		// Deliberately hash-based: the other channel's build is simply a DIFFERENT build,
		// and "is it newer" is not the question being asked.
		const remote: UpdateManifest = { version: "1.42.0", hash: "hash-unstable", sha: "deadbee", buildOrder: 1581 };
		expect(decideUpdate(stableBundle, "unstable", remote, isNewerVersion)).toEqual({
			kind: "switch",
			version: "1.42.0",
			to: "unstable",
			installsOlderBuild: false,
		});
	});

	it("offers an OLDER stable build and says so, instead of stranding the user", () => {
		// The consequence nobody would guess: switching back installs an older app, which
		// then reads state a newer build already wrote.
		const runningUnstable: LocalBuild = { ...unstableBundle, version: "1.43.0", buildOrder: 1600 };
		const remote: UpdateManifest = { version: "1.42.0", hash: "hash-stable" };
		expect(
			decideUpdate(runningUnstable, "stable", remote, isNewerVersion),
			"switching back to stable must OFFER the older build and flag it. Reporting `none` because stable is behind would strand the user on the very build they just rejected — a lockout, not a policy.",
		).toEqual({ kind: "switch", version: "1.42.0", to: "stable", installsOlderBuild: true });
	});

	it("offers nothing when both channels happen to be the same build", () => {
		const remote: UpdateManifest = { version: "1.42.0", hash: "hash-stable", buildOrder: 1580 };
		expect(decideUpdate(stableBundle, "unstable", remote, isNewerVersion)).toEqual({ kind: "none" });
	});

	it("rejects a manifest with no hash on every path", () => {
		expect(decideUpdate(stableBundle, "stable", { version: "1.43.0", hash: "" }, isNewerVersion).kind).toBe("error");
	});
});

describe("the build a user is running is visible in the window title", () => {
	// The whole "which build am I on?" affordance: no chrome, no header slot, and it
	// survives browser remote mode as the tab title.
	it("marks unstable and dev, and leaves stable unmarked", () => {
		expect(buildChannelTitlePrefix("unstable")).toBe("[UNSTABLE] ");
		expect(buildChannelTitlePrefix("dev")).toBe("[DEV from src] ");
		expect(
			buildChannelTitlePrefix("stable"),
			"stable must stay unmarked — a prefix every user sees forever is noise, and it is the non-default build that needs naming.",
		).toBe("");
		expect(buildChannelTitlePrefix(undefined)).toBe("");
	});
});
