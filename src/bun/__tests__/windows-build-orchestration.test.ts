import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBinaryName, cliCopyEntry } from "../../../electrobun.config";
import { cliBuildPlan } from "../../../scripts/build-cli";
import { nativeBuildPlan } from "../../../scripts/build-native";
import {
	descendantPids,
	isUsableReadyMarker,
	selectDesktopExecutable,
	selectWindowsArchive,
} from "../../../scripts/verify-windows-app-launch";
import { buildAppReadyMarker, writeAppReadyMarker } from "../app-ready-marker";

describe("packaged CLI binary naming", () => {
	it("suffixes the Windows binary with .exe and leaves POSIX bare", () => {
		expect(cliBinaryName("win32")).toBe("dev3.exe");
		expect(cliBinaryName("darwin")).toBe("dev3");
		expect(cliBinaryName("linux")).toBe("dev3");
	});

	it("maps the electrobun copy entry to the matching platform name", () => {
		expect(cliCopyEntry("win32")).toEqual(["dist/dev3.exe", "cli/dev3.exe"]);
		expect(cliCopyEntry("darwin")).toEqual(["dist/dev3", "cli/dev3"]);
	});
});

describe("build plans", () => {
	it("keeps the POSIX bash steps and drops them on Windows", () => {
		expect(cliBuildPlan("darwin")).toEqual({
			outfile: "dist/dev3",
			shellSteps: ["scripts/stage-bundled-tmux.sh", "scripts/sign-cli-binaries.sh"],
		});
		expect(cliBuildPlan("linux").shellSteps).toEqual([
			"scripts/stage-bundled-tmux.sh",
			"scripts/sign-cli-binaries.sh",
		]);
		expect(cliBuildPlan("win32")).toEqual({ outfile: "dist/dev3.exe", shellSteps: [] });
	});

	it("builds the macOS notification shim only where a shell exists", () => {
		expect(nativeBuildPlan("darwin").shellSteps).toEqual(["scripts/build-native-notifications.sh"]);
		expect(nativeBuildPlan("win32").shellSteps).toEqual([]);
	});
});

describe("app ready marker", () => {
	it("describes the running process", () => {
		const marker = buildAppReadyMarker("9.9.9", 1234, new Date("2026-07-25T10:00:00.000Z"));
		expect(marker).toEqual({
			ready: true,
			pid: process.pid,
			version: "9.9.9",
			platform: process.platform,
			startedAt: "2026-07-25T10:00:00.000Z",
			rendererReadyMs: 1234,
		});
	});

	it("records an unmeasured renderer as null rather than a fake zero", () => {
		expect(buildAppReadyMarker("9.9.9", null).rendererReadyMs).toBeNull();
	});

	it("writes atomically and leaves no temp file behind", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-ready-marker-"));
		try {
			const markerPath = join(dir, "nested", "app-ready.json");
			const written = writeAppReadyMarker("1.2.3", 900, markerPath);
			expect(written?.version).toBe("1.2.3");
			expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(written);
			expect(readdirSync(join(dir, "nested"))).toEqual(["app-ready.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is a no-op without a marker path and never throws on a bad one", () => {
		expect(writeAppReadyMarker("1.2.3", 900, undefined)).toBeNull();
		expect(writeAppReadyMarker("1.2.3", 900, "")).toBeNull();
		expect(writeAppReadyMarker("1.2.3", 900, join(tmpdir(), "dev3-missing\0path", "marker.json"))).toBeNull();
	});

	it("accepts only a complete Windows marker for the expected version", () => {
		const good = {
			ready: true,
			pid: 42,
			version: "1.2.3",
			platform: "win32",
			startedAt: "now",
			rendererReadyMs: 1500,
		};
		expect(isUsableReadyMarker(good, "1.2.3")).toBe(true);
		expect(isUsableReadyMarker(good, "1.2.4")).toBe(false);
		expect(isUsableReadyMarker({ ...good, ready: false }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker({ ...good, pid: 0 }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker({ ...good, platform: "darwin" }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker({ ...good, startedAt: "" }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker(null, "1.2.3")).toBe(false);
		// A Windows launch always measures the renderer; a marker that did not is
		// not proof of a watched launch.
		expect(isUsableReadyMarker({ ...good, rendererReadyMs: null }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker({ ...good, rendererReadyMs: -1 }, "1.2.3")).toBe(false);
	});
});

describe("windows package discovery", () => {
	it("picks the single update archive out of the artifact folder", () => {
		expect(
			selectWindowsArchive([
				"canary-win-x64-update.json",
				"canary-win-x64-dev-3.0-canary.tar.zst",
				"canary-win-x64-a1b2c3d4.patch",
				"canary-win-x64-dev-3.0-Setup-canary.zip",
			]),
		).toBe("canary-win-x64-dev-3.0-canary.tar.zst");
	});

	it("fails loudly when there is no archive or more than one", () => {
		expect(() => selectWindowsArchive(["canary-win-x64-update.json"])).toThrow(/package:win-archive/);
		expect(() =>
			selectWindowsArchive(["canary-win-x64-a.tar.zst", "stable-win-x64-a.tar.zst"]),
		).toThrow(/exactly one/);
	});

	// The real windows-latest layout: electrobun puts every executable in `bin/`,
	// the dev3 additions sit beside it, and nothing lands at the bundle root.
	const REAL_WINDOWS_BUNDLE = [
		"bin/bspatch.exe",
		"bin/bun.exe",
		"bin/launcher.exe",
		"bin/zig-zstd.exe",
		"cli/dev3.exe",
		"native-host-image/dev3-host-1.40.0/dev3-terminal-host.exe",
		"Resources/app/views/mainview/index.html",
	];

	it("selects the nested electrobun launcher out of the real Windows layout", () => {
		const selection = selectDesktopExecutable(REAL_WINDOWS_BUNDLE);
		expect(selection.relativePath).toBe("bin/launcher.exe");
		expect(selection.rejected.map((entry) => entry.relativePath)).toEqual([
			"bin/bspatch.exe",
			"bin/bun.exe",
			"bin/zig-zstd.exe",
			"cli/dev3.exe",
			"native-host-image/dev3-host-1.40.0/dev3-terminal-host.exe",
		]);
	});

	it("normalizes Windows separators and accepts a flat-root launcher", () => {
		expect(selectDesktopExecutable(["bin\\launcher.exe", "cli\\dev3.exe"]).relativePath).toBe("bin/launcher.exe");
		expect(selectDesktopExecutable(["launcher.exe", "bin\\bun.exe"]).relativePath).toBe("launcher.exe");
	});

	it("rejects the CLI, the terminal host, setup carriers and cached runtimes with reasons", () => {
		const rejected = selectDesktopExecutable([
			"bin/launcher.exe",
			"cli/dev3.exe",
			"native-host-image/dev3-host-1.40.0/dev3-terminal-host.exe",
			"dev-3.0-Setup.exe",
			"bin/bun.exe",
		]).rejected;
		expect(Object.fromEntries(rejected.map((entry) => [entry.relativePath, entry.reason]))).toEqual({
			"cli/dev3.exe": "outside the bundle exec directory 'bin/'",
			"native-host-image/dev3-host-1.40.0/dev3-terminal-host.exe": "outside the bundle exec directory 'bin/'",
			"dev-3.0-Setup.exe": "not the electrobun desktop launcher 'launcher.exe'",
			"bin/bun.exe": "not the electrobun desktop launcher 'launcher.exe'",
		});
	});

	it("fails with the full considered inventory when no launcher is present", () => {
		expect(() => selectDesktopExecutable(["cli/dev3.exe", "bin/bun.exe", "build.json"])).toThrow(
			/found 0[\s\S]*bin\/bun\.exe — rejected: not the electrobun desktop launcher[\s\S]*cli\/dev3\.exe — rejected: outside the bundle exec directory 'bin\/'/,
		);
		expect(() => selectDesktopExecutable(["build.json"])).toThrow(/Considered executables:\n {2}none/);
	});

	it("refuses to guess between ambiguous launcher candidates", () => {
		expect(() => selectDesktopExecutable(["bin/launcher.exe", "launcher.exe"])).toThrow(
			/found 2: bin\/launcher\.exe, launcher\.exe/,
		);
	});
});

describe("owned process tree", () => {
	it("collects every descendant of the launched executable", () => {
		const snapshot = [
			{ pid: 1, parentPid: 0, name: "system" },
			{ pid: 100, parentPid: 1, name: "dev-3.0.exe" },
			{ pid: 200, parentPid: 100, name: "bun.exe" },
			{ pid: 300, parentPid: 200, name: "dev3-terminal-host.exe" },
			{ pid: 400, parentPid: 1, name: "unrelated.exe" },
		];
		expect(descendantPids(snapshot, 100)).toEqual([200, 300]);
		expect(descendantPids(snapshot, 400)).toEqual([]);
	});

	it("does not loop on a self-parenting snapshot row", () => {
		expect(descendantPids([{ pid: 7, parentPid: 7, name: "weird.exe" }], 7)).toEqual([]);
	});
});
