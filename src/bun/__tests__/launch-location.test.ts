import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../electrobun-platform", () => ({ Updater: {}, Utils: {}, PATHS: {} }));
vi.mock("../quit-manager", () => ({ markQuitConfirmed: vi.fn() }));

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import {
	RELAUNCH_SCRIPT,
	applicationsDestination,
	detectLaunchLocationIssue,
	findSourceVolume,
	installBundleCopy,
	parseHdiutilMountPoints,
	readBundleVersion,
	relaunchCommand,
	runningBundlePath,
	type InstallDeps,
	type LaunchLocationEnv,
} from "../launch-location";

const HOME = "/Users/ada";
const TRANSLOCATED = "/private/var/folders/xy/T/AppTranslocation/1F2E-AB/d/dev-3.0.app";

function env(bundlePath: string, over: Partial<LaunchLocationEnv> = {}): LaunchLocationEnv {
	return {
		platform: "darwin",
		channel: "stable",
		bundlePath,
		home: HOME,
		replaceBlocker: () => "not writable",
		diskImageMounts: () => ["/Volumes/dev-3.0"],
		isWritable: () => true,
		...over,
	};
}

describe("detectLaunchLocationIssue", () => {
	const writable = { replaceBlocker: () => null };

	it.each([
		["mounted installer DMG", "/Volumes/dev-3.0/dev-3.0.app", {}, "disk-image", "/Volumes/dev-3.0"],
		["App Translocation copy of a DMG", TRANSLOCATED, { diskImageMounts: () => [] }, "translocated", null],
		["read-only folder elsewhere", "/Users/ada/Shared/dev-3.0.app", {}, "read-only", null],
		["read-only external volume (not an image)", "/Volumes/Backup/dev-3.0.app", {}, "read-only", null],
	] as const)("flags a %s", (_label, path, over, kind, volume) => {
		const issue = detectLaunchLocationIssue(env(path, over));
		expect(issue?.kind).toBe(kind);
		expect(issue?.volumePath).toBe(volume);
		expect(issue?.destination).toBe("/Applications/dev-3.0.app");
	});

	it.each([
		["brew/DMG install in /Applications", "/Applications/dev-3.0.app", writable],
		["user-owned ~/Applications install", `${HOME}/Applications/dev-3.0.app`, writable],
		["unwritable install already in /Applications (MDM)", "/Applications/dev-3.0.app", {}],
		["unwritable install already in ~/Applications", `${HOME}/Applications/dev-3.0.app`, {}],
		["writable external drive", "/Volumes/SSD/Apps/dev-3.0.app", writable],
		["writable disk image", "/Volumes/dev-3.0/dev-3.0.app", writable],
		["bun run dev build", "/Users/ada/src/dev-3.0/build/dev-macos-arm64/dev-3.0-dev.app", { channel: "dev" }],
		["dev channel even from a DMG", "/Volumes/dev-3.0/dev-3.0.app", { channel: "dev" }],
		["Linux", "/opt/dev-3.0/bin", { platform: "linux" }],
		["Windows", "C:\\Program Files\\dev-3.0", { platform: "win32" }],
		["a path that is not a bundle", "/Volumes/dev-3.0/bin", {}],
	] as const)("does not flag a %s", (_label, path, over) => {
		expect(detectLaunchLocationIssue(env(path, over))).toBeNull();
	});

	it("leaves the translocation verdict to the updater's blocker (it always refuses those)", () => {
		expect(detectLaunchLocationIssue(env(TRANSLOCATED, writable))).toBeNull();
	});

	it("falls back to ~/Applications when /Applications is not writable", () => {
		const issue = detectLaunchLocationIssue(env("/Volumes/dev-3.0/dev-3.0.app", { isWritable: (d) => d !== "/Applications" }));
		expect(issue?.destination).toBe(`${HOME}/Applications/dev-3.0.app`);
	});

	it("honours DEV3_APPLICATIONS_DIR so QA installs into a temp folder", () => {
		expect(applicationsDestination("/Volumes/x/dev-3.0.app", { home: HOME, isWritable: () => true }, "/tmp/qa")).toBe(
			"/tmp/qa/dev-3.0.app",
		);
	});

	it("keeps the bundle's own name (channel builds)", () => {
		expect(applicationsDestination("/Volumes/x/dev-3.0-canary.app", { home: HOME, isWritable: () => true })).toBe(
			"/Applications/dev-3.0-canary.app",
		);
	});
});

describe("relaunchCommand", () => {
	it("is a plain open in production", () => {
		expect(relaunchCommand("/Applications/dev-3.0.app", {})).toEqual(["open", "/Applications/dev-3.0.app"]);
	});

	it("carries a scoped home and tmux socket dir over to the new copy", () => {
		expect(relaunchCommand("/a/dev-3.0.app", { DEV3_HOME: "/tmp/h", TMUX_TMPDIR: "/tmp/t", PATH: "/bin" })).toEqual([
			"open", "--env", "DEV3_HOME=/tmp/h", "--env", "TMUX_TMPDIR=/tmp/t", "/a/dev-3.0.app",
		]);
	});
});

describe("runningBundlePath", () => {
	it("climbs from Contents/MacOS/<exe> to the bundle", () => {
		expect(runningBundlePath("/Volumes/dev-3.0/dev-3.0.app/Contents/MacOS/bun")).toBe("/Volumes/dev-3.0/dev-3.0.app");
	});
});

describe("findSourceVolume", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it("finds the mount the bundle sits on, not a mere prefix match", () => {
		expect(findSourceVolume("/Volumes/dev-3.0 1/dev-3.0.app", ["/Volumes/dev-3.0", "/Volumes/dev-3.0 1"])).toBe("/Volumes/dev-3.0 1");
	});

	it("for a translocated copy, finds the image that holds a same-named app", () => {
		dir = mkdtempSync(join(tmpdir(), "launch-location-"));
		const other = join(dir, "Other");
		const installer = join(dir, "Installer");
		mkdirSync(other);
		mkdirSync(join(installer, "dev-3.0.app"), { recursive: true });
		expect(findSourceVolume(TRANSLOCATED, [other, installer])).toBe(installer);
	});

	it("returns null for an ordinary folder", () => {
		expect(findSourceVolume("/Users/ada/Shared/dev-3.0.app", ["/Volumes/dev-3.0"])).toBeNull();
	});
});

describe("parseHdiutilMountPoints", () => {
	it("extracts every mount point and unescapes XML", () => {
		const plist = `<plist><dict><key>images</key><array>
			<dict><key>system-entities</key><array>
				<dict><key>dev-entry</key><string>/dev/disk4s1</string></dict>
				<dict><key>mount-point</key>
				<string>/Volumes/dev-3.0</string></dict>
			</array></dict>
			<dict><key>system-entities</key><array>
				<dict><key>mount-point</key><string>/Volumes/A &amp; B</string></dict>
			</array></dict>
		</array></dict></plist>`;
		expect(parseHdiutilMountPoints(plist)).toEqual(["/Volumes/dev-3.0", "/Volumes/A & B"]);
	});

	it("returns nothing when no image is attached", () => {
		expect(parseHdiutilMountPoints("<plist><dict><key>images</key><array/></dict></plist>")).toEqual([]);
	});
});

describe("readBundleVersion", () => {
	it("reads CFBundleShortVersionString from Info.plist", () => {
		const dir = mkdtempSync(join(tmpdir(), "launch-location-"));
		try {
			mkdirSync(join(dir, "x.app", "Contents"), { recursive: true });
			writeFileSync(
				join(dir, "x.app", "Contents", "Info.plist"),
				"<dict><key>CFBundleName</key><string>x</string><key>CFBundleShortVersionString</key>\n\t<string>1.62.2</string></dict>",
			);
			expect(readBundleVersion(join(dir, "x.app"))).toBe("1.62.2");
			expect(readBundleVersion(join(dir, "missing.app"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("installBundleCopy", () => {
	const SRC = "/Volumes/dev-3.0/dev-3.0.app";
	const DEST = "/Applications/dev-3.0.app";

	function deps(opts: { destExists: boolean; versions?: Record<string, string>; fail?: (cmd: string[]) => boolean }) {
		const calls: string[][] = [];
		const d: InstallDeps = {
			pid: 42,
			exists: (p) => p === DEST && opts.destExists,
			readVersion: (p) => opts.versions?.[p] ?? null,
			run: async (cmd) => {
				calls.push(cmd);
				return opts.fail?.(cmd) ? { exitCode: 1, stderr: "boom" } : { exitCode: 0, stderr: "" };
			},
		};
		return { d, calls };
	}

	it("copies with ditto, strips quarantine and places the copy", async () => {
		const { d, calls } = deps({ destExists: false });
		expect(await installBundleCopy(SRC, DEST, d)).toEqual({ launch: DEST, replaced: true });
		expect(calls).toContainEqual(["ditto", SRC, `${DEST}.dev3-move-42`]);
		expect(calls).toContainEqual(["xattr", "-dr", "com.apple.quarantine", `${DEST}.dev3-move-42`]);
		expect(calls).toContainEqual(["mv", `${DEST}.dev3-move-42`, DEST]);
		expect(calls.some((c) => c[0] === "mv" && c[1] === DEST)).toBe(false);
	});

	it("replaces an older copy, moving it aside first and deleting it after", async () => {
		const { d, calls } = deps({ destExists: true, versions: { [SRC]: "1.62.2", [DEST]: "1.52.0" } });
		await installBundleCopy(SRC, DEST, d);
		const i = (cmd: string[]) => calls.findIndex((c) => c.join(" ") === cmd.join(" "));
		expect(i(["mv", DEST, `${DEST}.dev3-old-42`])).toBeLessThan(i(["mv", `${DEST}.dev3-move-42`, DEST]));
		expect(i(["rm", "-rf", `${DEST}.dev3-old-42`])).toBeGreaterThan(i(["mv", `${DEST}.dev3-move-42`, DEST]));
	});

	it("never downgrades: a newer copy already in Applications is launched untouched", async () => {
		const { d, calls } = deps({ destExists: true, versions: { [SRC]: "1.52.0", [DEST]: "1.62.2" } });
		expect(await installBundleCopy(SRC, DEST, d)).toEqual({ launch: DEST, replaced: false });
		expect(calls).toEqual([]);
	});

	it("restores the old copy when placing the new one fails", async () => {
		const { d, calls } = deps({
			destExists: true,
			versions: { [SRC]: "1.62.2", [DEST]: "1.52.0" },
			fail: (c) => c[0] === "mv" && c[1] === `${DEST}.dev3-move-42`,
		});
		await expect(installBundleCopy(SRC, DEST, d)).rejects.toThrow(/Placing the new copy failed: boom/);
		expect(calls).toContainEqual(["mv", `${DEST}.dev3-old-42`, DEST]);
		expect(calls[calls.length - 1]).toEqual(["rm", "-rf", `${DEST}.dev3-move-42`]);
	});

	it("reports a failed copy and leaves no staging copy behind", async () => {
		const { d, calls } = deps({ destExists: false, fail: (c) => c[0] === "ditto" });
		await expect(installBundleCopy(SRC, DEST, d)).rejects.toThrow(/Copying dev3 failed: boom/);
		expect(calls[calls.length - 1]).toEqual(["rm", "-rf", `${DEST}.dev3-move-42`]);
	});
});

describe("on a real Mac", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it.runIf(process.platform === "darwin")("copies a quarantined bundle over an older one with real ditto/xattr/mv", async () => {
		dir = mkdtempSync(join(tmpdir(), "launch-location-"));
		const plist = (v: string) => `<dict><key>CFBundleShortVersionString</key><string>${v}</string></dict>`;
		const src = join(dir, "Installer", "dev-3.0.app");
		const dest = join(dir, "Applications", "dev-3.0.app");
		for (const [bundle, v] of [[src, "1.62.2"], [dest, "1.52.0"]] as const) {
			mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
			writeFileSync(join(bundle, "Contents", "Info.plist"), plist(v));
		}
		writeFileSync(join(src, "Contents", "MacOS", "bun"), "#!/bin/sh\n");
		spawnSync("xattr", ["-w", "com.apple.quarantine", "0083;00000000;Safari;", join(src, "Contents", "MacOS", "bun")]);

		expect(spawnSync("xattr", [join(src, "Contents", "MacOS", "bun")]).stdout.toString()).toContain("com.apple.quarantine");
		// Bun.spawn is stubbed under vitest (Node), so drive the real tools through child_process.
		const real: InstallDeps = {
			pid: process.pid,
			exists: existsSync,
			readVersion: readBundleVersion,
			run: async ([cmd, ...args]) => {
				const r = spawnSync(cmd, args);
				return { exitCode: r.status ?? 1, stderr: r.stderr.toString() };
			},
		};
		expect(await installBundleCopy(src, dest, real)).toEqual({ launch: dest, replaced: true });
		expect(readBundleVersion(dest)).toBe("1.62.2");
		const xattrs = spawnSync("xattr", [join(dest, "Contents", "MacOS", "bun")]).stdout.toString();
		expect(xattrs).not.toContain("com.apple.quarantine");
		expect(existsSync(`${dest}.dev3-old-${process.pid}`)).toBe(false);
		expect(existsSync(`${dest}.dev3-move-${process.pid}`)).toBe(false);
	});

	it.runIf(process.platform !== "win32")("relaunch helper opens the new copy, then ejects the volume", () => {
		dir = mkdtempSync(join(tmpdir(), "launch-location-"));
		const log = join(dir, "log");
		for (const tool of ["open", "hdiutil", "sleep"]) {
			const bin = join(dir, tool);
			writeFileSync(bin, `#!/bin/sh\necho "${tool} $*" >> "${log}"\n`);
			chmodSync(bin, 0o755);
		}
		const deadPid = "999999";
		const r = spawnSync("/bin/sh", ["-c", RELAUNCH_SCRIPT, "x", deadPid, "/Volumes/dev 3", "open", "/Applications/dev-3.0.app"], {
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
		});
		expect(r.status).toBe(0);
		expect(readFileSync(log, "utf-8").split("\n").filter((l) => !l.startsWith("sleep"))).toEqual([
			"open /Applications/dev-3.0.app",
			"hdiutil detach /Volumes/dev 3 -quiet",
			"",
		]);
	});
});
