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
		const marker = buildAppReadyMarker("9.9.9", new Date("2026-07-25T10:00:00.000Z"));
		expect(marker).toEqual({
			ready: true,
			pid: process.pid,
			version: "9.9.9",
			platform: process.platform,
			startedAt: "2026-07-25T10:00:00.000Z",
		});
	});

	it("writes atomically and leaves no temp file behind", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-ready-marker-"));
		try {
			const markerPath = join(dir, "nested", "app-ready.json");
			const written = writeAppReadyMarker("1.2.3", markerPath);
			expect(written?.version).toBe("1.2.3");
			expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(written);
			expect(readdirSync(join(dir, "nested"))).toEqual(["app-ready.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is a no-op without a marker path and never throws on a bad one", () => {
		expect(writeAppReadyMarker("1.2.3", undefined)).toBeNull();
		expect(writeAppReadyMarker("1.2.3", "")).toBeNull();
		expect(writeAppReadyMarker("1.2.3", join(tmpdir(), "dev3-missing\0path", "marker.json"))).toBeNull();
	});

	it("accepts only a complete Windows marker for the expected version", () => {
		const good = { ready: true, pid: 42, version: "1.2.3", platform: "win32", startedAt: "now" };
		expect(isUsableReadyMarker(good, "1.2.3")).toBe(true);
		expect(isUsableReadyMarker(good, "1.2.4")).toBe(false);
		expect(isUsableReadyMarker({ ...good, ready: false }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker({ ...good, pid: 0 }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker({ ...good, platform: "darwin" }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker({ ...good, startedAt: "" }, "1.2.3")).toBe(false);
		expect(isUsableReadyMarker(null, "1.2.3")).toBe(false);
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

	it("treats the only top-level exe as the desktop executable", () => {
		expect(selectDesktopExecutable(["dev-3.0.exe", "build.json", "changelog.json"])).toBe("dev-3.0.exe");
		expect(() => selectDesktopExecutable(["build.json"])).toThrow(/exactly one/);
		expect(() => selectDesktopExecutable(["a.exe", "b.exe"])).toThrow(/exactly one/);
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
