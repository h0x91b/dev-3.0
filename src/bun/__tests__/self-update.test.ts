import { describe, expect, it } from "vitest";
import {
	brewLinkedBin,
	detectInstallMethod,
	evaluateQuietWindow,
	MAX_UPDATE_ATTEMPTS,
	planUpdate,
	QUIET_CEILING_MS,
	QUIET_HOLD_MS,
	RETRY_MAX_MS,
	retryBackoffMs,
	tarballUrl,
	type InstallMethod,
	type UpdatePlanInput,
} from "../../shared/self-update";
import { chooseRestartStrategy } from "../self-update";

describe("detectInstallMethod", () => {
	const cases: Array<[string, NodeJS.Platform, InstallMethod]> = [
		// A source checkout is recognised by the EXECUTABLE, before any path shape,
		// because `bun` can be run from a directory that looks like a tarball install.
		["/opt/homebrew/bin/bun", "darwin", "source"],
		["/Users/x/dev-3.0/node_modules/.bin/bun", "darwin", "source"],
		["C:/Users/x/.bun/bin/bun.exe", "win32", "source"],
		// Homebrew formula — the keg directory is the marker, not the prefix, because
		// the prefix differs per platform and per architecture.
		["/opt/homebrew/Cellar/dev3/1.45.2/libexec/dev3", "darwin", "brew-formula"],
		["/usr/local/Cellar/dev3/1.45.2/libexec/dev3", "darwin", "brew-formula"],
		["/home/linuxbrew/.linuxbrew/Cellar/dev3/1.45.2/libexec/dev3", "linux", "brew-formula"],
		// A macOS app bundle. Homebrew Cask MOVES the .app to /Applications, so a cask
		// install is NOT under Caskroom and looks exactly like a DMG install here —
		// telling them apart is brew's recorded version, not the path.
		["/Applications/dev-3.0.app/Contents/Resources/app/cli/dev3", "darwin", "app-bundle"],
		["/Users/x/Applications/dev-3.0.app/Contents/MacOS/dev3", "darwin", "app-bundle"],
		// Plain tarball installs.
		["/Users/x/.dev3/dev3", "darwin", "tarball"],
		["/opt/dev3/dev3", "linux", "tarball"],
		["/usr/local/bin/dev3", "linux", "tarball"],
		// `.app` is a macOS concept: the same path on Linux is just a directory name.
		["/srv/dev-3.0.app/dev3", "linux", "tarball"],
	];

	for (const [path, platform, expected] of cases) {
		it(`classifies ${path} on ${platform} as ${expected}`, () => {
			expect(detectInstallMethod(path, platform)).toBe(expected);
		});
	}

	it("normalises Windows separators before matching", () => {
		expect(detectInstallMethod("C:\\Users\\x\\.bun\\bin\\bun.exe", "win32")).toBe("source");
	});

	// `<dev3Home>/bin/dev3` is a real 76 MB copy the GUI rewrites on every launch, and
	// it is what `which dev3` resolves to on any machine the app has ever started.
	// Classified as a tarball, an update would extract a release tree into the frozen
	// `~/.dev3.0/` layout, leave the real install on the old version, and get reverted
	// by the next GUI launch.
	describe("the PATH copy the app maintains", () => {
		const binDir = "/Users/x/.dev3.0/bin";

		it("is not an install", () => {
			expect(detectInstallMethod(`${binDir}/dev3`, "darwin", binDir)).toBe("path-copy");
		});

		it("is recognised with a trailing slash on the bin dir too", () => {
			expect(detectInstallMethod(`${binDir}/dev3`, "darwin", `${binDir}/`)).toBe("path-copy");
		});

		it("does not swallow a real install that merely starts with a similar name", () => {
			expect(detectInstallMethod("/Users/x/.dev3.0/binaries/dev3", "darwin", binDir)).toBe("tarball");
		});

		it("still classifies everything else normally when the bin dir is known", () => {
			expect(detectInstallMethod("/opt/homebrew/Cellar/dev3/1.45.2/libexec/dev3", "darwin", binDir))
				.toBe("brew-formula");
			expect(detectInstallMethod("/opt/homebrew/bin/bun", "darwin", binDir)).toBe("source");
		});
	});
});

describe("tarballUrl", () => {
	it("uses the release TAG directory on stable", () => {
		expect(tarballUrl({ channel: "stable", platform: "darwin", arch: "arm64", version: "1.45.2" }))
			.toBe("https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0/v1.45.2/dev3-cli-macos-arm64.tar.gz");
	});

	it("uses the COMMIT directory on canary, because canary has no tag", () => {
		expect(tarballUrl({
			channel: "canary",
			platform: "linux",
			arch: "x64",
			version: "1.45.2+canary.abc12345",
			sha: "abc12345def",
		})).toBe("https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0/abc12345def/dev3-cli-linux-x64.tar.gz");
	});

	it("strips the build-metadata suffix out of a stable directory name", () => {
		expect(tarballUrl({ channel: "stable", platform: "darwin", arch: "x64", version: "1.45.2+canary.abc" }))
			.toContain("/v1.45.2/");
	});

	it("refuses to guess a directory when a canary manifest has no sha", () => {
		expect(tarballUrl({ channel: "canary", platform: "linux", arch: "arm64", version: "1.45.2" })).toBeNull();
	});

	it("maps any unexpected arch onto x64 rather than inventing a URL", () => {
		expect(tarballUrl({ channel: "stable", platform: "linux", arch: "riscv64", version: "1.0.0" }))
			.toContain("dev3-cli-linux-x64.tar.gz");
	});
});

describe("planUpdate", () => {
	const base: UpdatePlanInput = {
		install: "tarball",
		channel: "stable",
		platform: "linux",
		arch: "x64",
		runningVersion: "1.45.0",
		brewCaskVersion: null,
		offered: { version: "1.45.2", sha: "deadbeef" },
	};

	it("refuses a source checkout, before it even looks at the offer", () => {
		const plan = planUpdate({ ...base, install: "source", offered: null });
		expect(plan.kind).toBe("refused");
		if (plan.kind === "refused") expect(plan.reason).toContain("from source");
	});

	it("refuses the app's PATH copy, naming why updating it would be pointless", () => {
		const plan = planUpdate({ ...base, install: "path-copy" });
		expect(plan.kind).toBe("refused");
		if (plan.kind === "refused") {
			expect(plan.reason).toContain("PATH");
			expect(plan.reason).toContain("overwritten");
		}
	});

	it("refuses Windows: there is no Windows CLI tarball to install", () => {
		const plan = planUpdate({ ...base, platform: "win32" });
		expect(plan.kind).toBe("refused");
		if (plan.kind === "refused") expect(plan.reason).toContain("Windows");
	});

	it("reports up-to-date when nothing is offered", () => {
		expect(planUpdate({ ...base, offered: null })).toEqual({ kind: "up-to-date", version: "1.45.0" });
	});

	it("hands a stable brew formula to brew", () => {
		const plan = planUpdate({ ...base, install: "brew-formula" });
		expect(plan).toEqual({ kind: "brew", version: "1.45.2", cask: false, command: ["brew", "upgrade", "dev3"] });
	});

	it("serves a CANARY brew formula the tarball — the tap only ever carries stable", () => {
		const plan = planUpdate({ ...base, install: "brew-formula", channel: "canary" });
		expect(plan.kind).toBe("tarball");
		if (plan.kind === "tarball") expect(plan.url).toContain("/deadbeef/");
	});

	it("upgrades a cask when brew's recorded version matches what is running", () => {
		const plan = planUpdate({
			...base,
			install: "app-bundle",
			platform: "darwin",
			brewCaskVersion: "1.45.0",
		});
		expect(plan).toEqual({
			kind: "brew",
			version: "1.45.2",
			cask: true,
			command: ["brew", "upgrade", "--cask", "dev3"],
		});
	});

	it("ignores build metadata when comparing the cask version against the running one", () => {
		const plan = planUpdate({
			...base,
			install: "app-bundle",
			platform: "darwin",
			runningVersion: "1.45.0+canary.abc",
			brewCaskVersion: "1.45.0",
		});
		expect(plan.kind).toBe("brew");
	});

	it("refuses a cask whose version has DRIFTED — the app updated itself past brew", () => {
		const plan = planUpdate({
			...base,
			install: "app-bundle",
			platform: "darwin",
			runningVersion: "1.45.1",
			brewCaskVersion: "1.44.0",
		});
		expect(plan.kind).toBe("refused");
		if (plan.kind === "refused") {
			expect(plan.reason).toContain("1.44.0");
			expect(plan.reason).toContain("1.45.1");
			expect(plan.reason).toContain("brew upgrade --cask dev3");
		}
	});

	it("refuses an app bundle brew does not manage (DMG / hand-copied install)", () => {
		const plan = planUpdate({ ...base, install: "app-bundle", platform: "darwin", brewCaskVersion: null });
		expect(plan.kind).toBe("refused");
		if (plan.kind === "refused") expect(plan.reason).toContain("does not manage");
	});

	it("refuses an app bundle on canary — only the desktop updater can swap a bundle", () => {
		const plan = planUpdate({
			...base,
			install: "app-bundle",
			platform: "darwin",
			channel: "canary",
			brewCaskVersion: "1.45.0",
		});
		expect(plan.kind).toBe("refused");
		if (plan.kind === "refused") expect(plan.reason).toContain("desktop app");
	});

	it("plans a tarball install for a tarball install", () => {
		const plan = planUpdate(base);
		expect(plan.kind).toBe("tarball");
		if (plan.kind === "tarball") expect(plan.url).toContain("/v1.45.2/dev3-cli-linux-x64.tar.gz");
	});

	it("refuses rather than guessing when the canary tarball cannot be located", () => {
		const plan = planUpdate({ ...base, channel: "canary", offered: { version: "1.45.2" } });
		expect(plan.kind).toBe("refused");
		if (plan.kind === "refused") expect(plan.reason).toContain("no commit sha");
	});
});

describe("evaluateQuietWindow", () => {
	const now = 1_000_000_000_000;
	const base = {
		tasksInProgress: 0,
		ptyIdleMs: 10 * 60_000,
		browserClients: 0,
		quietSinceMs: now - QUIET_HOLD_MS,
		pendingSinceMs: now - 60_000,
		failedAttempts: 0,
		lastFailureMs: null,
		now,
	};

	it("applies once all three conditions have held long enough", () => {
		const verdict = evaluateQuietWindow(base);
		expect(verdict.decision).toBe("apply");
	});

	it("waits — and RESETS the hold clock — while a task is in progress", () => {
		const verdict = evaluateQuietWindow({ ...base, tasksInProgress: 2 });
		expect(verdict.decision).toBe("wait");
		expect(verdict.reason).toContain("2 task");
		expect(verdict.quietSinceMs).toBeNull();
	});

	it("waits while a browser is connected — someone is looking at the board", () => {
		const verdict = evaluateQuietWindow({ ...base, browserClients: 1 });
		expect(verdict.decision).toBe("wait");
		expect(verdict.quietSinceMs).toBeNull();
	});

	it("waits while a terminal is still producing output", () => {
		const verdict = evaluateQuietWindow({ ...base, ptyIdleMs: 5_000 });
		expect(verdict.decision).toBe("wait");
		expect(verdict.reason).toContain("producing output");
	});

	it("treats an UNREADABLE activity probe as busy, not as quiet", () => {
		const verdict = evaluateQuietWindow({ ...base, ptyIdleMs: null });
		expect(verdict.decision).toBe("wait");
		expect(verdict.reason).toContain("could not be read");
	});

	it("starts the hold clock on the first quiet tick instead of applying immediately", () => {
		const verdict = evaluateQuietWindow({ ...base, quietSinceMs: null });
		expect(verdict.decision).toBe("wait");
		expect(verdict.quietSinceMs).toBe(now);
	});

	it("keeps waiting until the hold is fully served", () => {
		const verdict = evaluateQuietWindow({ ...base, quietSinceMs: now - (QUIET_HOLD_MS - 1_000) });
		expect(verdict.decision).toBe("wait");
		expect(verdict.quietSinceMs).toBe(now - (QUIET_HOLD_MS - 1_000));
	});

	it("past the 72h ceiling, a connected browser and a busy terminal stop mattering", () => {
		const verdict = evaluateQuietWindow({
			...base,
			pendingSinceMs: now - QUIET_CEILING_MS - 1,
			browserClients: 3,
			ptyIdleMs: 0,
			quietSinceMs: null,
		});
		expect(verdict.decision).toBe("apply");
		expect(verdict.reason).toContain("ceiling");
	});

	it("but the ceiling never overrides a task in progress", () => {
		const verdict = evaluateQuietWindow({
			...base,
			pendingSinceMs: now - QUIET_CEILING_MS - 1,
			tasksInProgress: 1,
		});
		expect(verdict.decision).toBe("wait");
	});

	// Past the ceiling the quiet conditions stop applying, so WITHOUT a backoff a
	// permanently broken update re-attempts on every 30-minute tick, 48 times a day.
	it("backs off after a failure instead of retrying on the very next tick", () => {
		const verdict = evaluateQuietWindow({ ...base, failedAttempts: 1, lastFailureMs: now - 60_000 });
		expect(verdict.decision).toBe("wait");
		expect(verdict.reason).toContain("backing off");
	});

	it("tries again once the backoff has elapsed", () => {
		const verdict = evaluateQuietWindow({
			...base,
			failedAttempts: 1,
			lastFailureMs: now - retryBackoffMs(1) - 1,
		});
		expect(verdict.decision).toBe("apply");
	});

	it("keeps backing off past the ceiling too — the ceiling is not an override", () => {
		const verdict = evaluateQuietWindow({
			...base,
			pendingSinceMs: now - QUIET_CEILING_MS - 1,
			failedAttempts: 2,
			lastFailureMs: now - 1_000,
		});
		expect(verdict.decision).toBe("wait");
		expect(verdict.reason).toContain("backing off");
	});

	it("gives up on a version after MAX_UPDATE_ATTEMPTS, however quiet the box is", () => {
		const verdict = evaluateQuietWindow({
			...base,
			failedAttempts: MAX_UPDATE_ATTEMPTS,
			lastFailureMs: now - RETRY_MAX_MS * 10,
		});
		expect(verdict.decision).toBe("wait");
		expect(verdict.reason).toContain("all failed");
	});

	it("doubles the wait per failure and then caps it", () => {
		expect(retryBackoffMs(0)).toBe(0);
		expect(retryBackoffMs(2)).toBe(retryBackoffMs(1) * 2);
		expect(retryBackoffMs(99)).toBe(RETRY_MAX_MS);
	});
});

describe("brewLinkedBin", () => {
	// A formula upgrade puts the new build in a NEW keg and only moves
	// `<prefix>/bin/dev3`; restarting the keg path we were started from comes back on
	// the OLD version and offers the same update forever.
	it("points at the brew symlink, not the version-pinned keg", () => {
		expect(brewLinkedBin("/opt/homebrew/Cellar/dev3/1.45.2/libexec/dev3")).toBe("/opt/homebrew/bin/dev3");
		expect(brewLinkedBin("/home/linuxbrew/.linuxbrew/Cellar/dev3/1.45.2/libexec/dev3"))
			.toBe("/home/linuxbrew/.linuxbrew/bin/dev3");
	});

	it("returns null for anything that is not a keg, rather than guessing a prefix", () => {
		expect(brewLinkedBin("/Users/x/.dev3/dev3")).toBeNull();
		expect(brewLinkedBin("/Applications/dev-3.0.app/Contents/MacOS/dev3")).toBeNull();
	});
});

describe("chooseRestartStrategy", () => {
	it("lets a systemd unit do the relaunch — a helper would die with the cgroup", () => {
		expect(chooseRestartStrategy({ INVOCATION_ID: "abc", DEV3_REMOTE_LOG_FILE: "/tmp/x.log" }))
			.toBe("supervisor-exit");
	});

	it("spawns a helper for the unsupervised background server", () => {
		expect(chooseRestartStrategy({ DEV3_REMOTE_LOG_FILE: "/tmp/x.log" })).toBe("helper");
	});

	// A human watching a terminal is NOT a supervisor. Exiting there leaves the box
	// dark until somebody notices — the exact failure this feature exists to prevent.
	it("refuses to exit an interactive foreground run, because nothing would relaunch it", () => {
		expect(chooseRestartStrategy({}, true)).toBe("none");
	});

	it("still exits for a container CMD, which has no TTY but does have a restart policy", () => {
		expect(chooseRestartStrategy({}, false)).toBe("supervisor-exit");
	});

	it("lets the markers win over the TTY either way", () => {
		expect(chooseRestartStrategy({ INVOCATION_ID: "abc" }, true)).toBe("supervisor-exit");
		expect(chooseRestartStrategy({ DEV3_REMOTE_LOG_FILE: "/tmp/x.log" }, true)).toBe("helper");
	});
});
