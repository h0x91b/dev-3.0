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
	livePidSet,
	newProcessQueryStats,
	parseTasklistPids,
	runProcessQuery,
	selectDesktopExecutable,
	selectWindowsArchive,
} from "../../../scripts/verify-windows-app-launch";
import {
	bundleExecutableNames,
	candidateHolders,
	interpretProcessRows,
	isInsideDirectory,
	parseProcessPaths,
	parseTasklistCsv,
	planBuildFolderRelease,
	refusedPackagedCliMessage,
	shouldFreeBuildFolder,
	stuckBuildFolderMessage,
} from "../../../scripts/free-build-folder";
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

describe("windows process queries", () => {
	const TASKLIST_CSV = [
		'"System Idle Process","0","Services","0","8 K"',
		'"launcher.exe","7652","Console","2","12,340 K"',
		'"msedgewebview2.exe","6928","Console","2","210,004 K"',
	].join("\r\n");

	it("reads pids out of tasklist CSV rows regardless of the machine's language", () => {
		expect(parseTasklistPids(TASKLIST_CSV)).toEqual([0, 7652, 6928]);
		// A localized Windows translates the memory unit and the session name; only the
		// quoted image/pid pair is depended on.
		expect(parseTasklistPids('"launcher.exe","4242","Консоль","2","57 400 КБ"')).toEqual([4242]);
		expect(parseTasklistPids('INFO: No tasks are running which match the specified criteria.')).toEqual([]);
	});

	it("refuses to read an unparseable process list as an empty machine", () => {
		expect([...livePidSet(TASKLIST_CSV)]).toEqual([0, 7652, 6928]);
		expect(() => livePidSet("PID | NAME\n7652 | launcher.exe")).toThrow(
			/no parseable process rows[\s\S]*CAUSE[\s\S]*row shape changed[\s\S]*FIX[\s\S]*passes a shutdown that never happened/,
		);
	});

	it("times a first-attempt success and does not retry it", () => {
		const stats = newProcessQueryStats();
		let calls = 0;
		const clock = fakeClock([0, 900]);
		const output = runProcessQuery("tree walk", stats, 3, () => {
			calls += 1;
			return { status: 0, stdout: " [] \n", stderr: "" };
		}, clock);
		expect(output).toBe("[]");
		expect(calls).toBe(1);
		expect(stats).toEqual({ calls: 1, attempts: 1, maxMs: 900, totalMs: 900 });
	});

	it("survives a stalled attempt and times the stall it survived", () => {
		const stats = newProcessQueryStats();
		const results = [timedOut(), timedOut(), { status: 0, stdout: "ok", stderr: "" }];
		const clock = fakeClock([0, 60_000, 60_000, 61_200, 61_200, 61_800]);
		expect(runProcessQuery("tree walk", stats, 3, () => results.shift()!, clock)).toBe("ok");
		expect(stats).toEqual({ calls: 1, attempts: 3, maxMs: 60_000, totalMs: 61_800 });
	});

	it("blames the runner's process query, not the app, once the attempts are spent", () => {
		const stats = newProcessQueryStats();
		expect(() => runProcessQuery("Windows process tree snapshot", stats, 3, timedOut, fakeClock([]))).toThrow(
			/failed on all 3 attempts[\s\S]*ETIMEDOUT[\s\S]*CAUSE: the runner's own process query[\s\S]*FIX[\s\S]*rather than raising the budget/,
		);
		expect(stats.attempts).toBe(3);
	});
});

function timedOut(): { status: null; stdout: string; stderr: string; error: Error } {
	return { status: null, stdout: "", stderr: "", error: new Error("spawnSync powershell.exe ETIMEDOUT") };
}

/** Reads the listed instants in order, then holds the last one. */
function fakeClock(instants: number[]): () => number {
	let index = 0;
	return () => instants[Math.min(index++, instants.length - 1)] ?? 0;
}

describe("freeing the build folder before electrobun wipes it", () => {
	const BUILD_DIR = "D:\\src\\dev-3.0\\build\\dev-win-x64";

	it("runs on Windows only — every other host leaves electrobun's own wipe alone", () => {
		expect(shouldFreeBuildFolder("win32")).toBe(true);
		expect(shouldFreeBuildFolder("darwin")).toBe(false);
		expect(shouldFreeBuildFolder("linux")).toBe(false);
	});

	it("matches the folder and its contents, case- and separator-insensitively", () => {
		expect(isInsideDirectory(BUILD_DIR, BUILD_DIR)).toBe(true);
		expect(isInsideDirectory(BUILD_DIR, `${BUILD_DIR}\\dev-3.0\\bin\\launcher.exe`)).toBe(true);
		expect(isInsideDirectory(BUILD_DIR, "d:/src/dev-3.0/build/dev-win-x64/dev-3.0/bin/bun.exe")).toBe(true);
		expect(isInsideDirectory(`${BUILD_DIR}\\`, `${BUILD_DIR}\\bin\\bun.exe`)).toBe(true);
	});

	it("does not reach into a neighbouring folder that merely shares the prefix", () => {
		expect(isInsideDirectory(BUILD_DIR, `${BUILD_DIR}-old\\bin\\launcher.exe`)).toBe(false);
		expect(isInsideDirectory(BUILD_DIR, "D:\\src\\dev-3.0\\build\\dev-win-arm64\\bin\\bun.exe")).toBe(false);
		expect(isInsideDirectory("", "D:\\anything")).toBe(false);
	});

	it("reads tasklist CSV without depending on a localized header", () => {
		expect(parseTasklistCsv('"launcher.exe","1234","Console","1","52,000 K"\r\n"bun.exe","5678","Console","1","9 K"\r\n')).toEqual([
			{ pid: 1234, name: "launcher.exe", executablePath: null },
			{ pid: 5678, name: "bun.exe", executablePath: null },
		]);
		expect(parseTasklistCsv("INFO: No tasks are running which match the specified criteria.")).toEqual([]);
		// Real tasklist output opens with pid 0, which is not a killable process.
		expect(parseTasklistCsv('"System Idle Process","0","Services","0","8 K"')).toEqual([]);
		// Only a row that STARTS with the name/pid pair counts — a quoted pair inside
		// any other text (a window title, a translated notice) is not a process.
		expect(parseTasklistCsv('NOTE: nothing here "evil.exe","666" still nothing')).toEqual([]);
	});

	it("reads the narrow image-path query, including the single-row object form", () => {
		expect(
			parseProcessPaths('[{"Id":100,"ProcessName":"launcher","Path":"C:\\\\a\\\\launcher.exe"},{"Id":0,"ProcessName":"idle","Path":null}]'),
		).toEqual([{ pid: 100, name: "launcher", executablePath: "C:\\a\\launcher.exe" }]);
		expect(parseProcessPaths('{"Id":7,"ProcessName":"bun","Path":null}')).toEqual([
			{ pid: 7, name: "bun", executablePath: null },
		]);
		expect(parseProcessPaths("not json")).toEqual([]);
	});

	it("treats a zero-row parse as a broken query, not as an empty machine", () => {
		const empty = interpretProcessRows("tasklist", []);
		expect(empty.rows).toEqual([]);
		expect(empty.failure).toBe("tasklist produced output that parsed to zero processes");
		expect(interpretProcessRows("tasklist", [{ pid: 1, name: "a.exe", executablePath: null }]).failure).toBeNull();
	});

	it("derives the candidate names from the bundle on disk, not a hardcoded list", () => {
		const tree: Record<string, string[]> = {
			[BUILD_DIR]: ["dev-3.0"],
			[`${BUILD_DIR}\\dev-3.0`]: ["bin", "Resources"],
			[`${BUILD_DIR}\\dev-3.0\\bin`]: ["launcher.exe", "bun.exe", "build.json"],
			[`${BUILD_DIR}\\dev-3.0\\Resources`]: ["dev3.exe"],
		};
		expect(bundleExecutableNames(BUILD_DIR, (dir) => tree[dir] ?? [])).toEqual(
			new Set(["launcher.exe", "bun.exe", "dev3.exe"]),
		);
	});

	it("asks the expensive path query only about names the bundle ships, and never about itself", () => {
		const rows = parseTasklistCsv(
			'"launcher.exe","100","Console","1","1 K"\r\n"chrome.exe","200","Console","1","1 K"\r\n"bun.exe","300","Console","1","1 K"',
		);
		expect(candidateHolders(rows, new Set(["launcher.exe", "bun.exe"]), 300).map((row) => row.pid)).toEqual([100]);
	});

	it("kills this build's own app image and refuses the packaged CLI another task may be using", () => {
		const rows = [
			{ pid: 100, name: "launcher", executablePath: `${BUILD_DIR}\\dev-3.0\\bin\\launcher.exe` },
			{ pid: 200, name: "bun", executablePath: `${BUILD_DIR}\\dev-3.0\\bin\\bun.exe` },
			{ pid: 300, name: "dev3", executablePath: `${BUILD_DIR}\\dev-3.0\\Resources\\app\\cli\\dev3.exe` },
			{ pid: 400, name: "bun", executablePath: "C:\\Users\\dev\\.bun\\bin\\bun.exe" },
			{ pid: 500, name: "System", executablePath: null },
			{ pid: 600, name: "self", executablePath: `${BUILD_DIR}\\dev-3.0\\bin\\bun.exe` },
		];
		const release = planBuildFolderRelease(rows, BUILD_DIR, 600);
		expect(release.kill.map((row) => row.pid)).toEqual([100, 200]);
		expect(release.refuse.map((row) => row.pid)).toEqual([300]);
	});

	it("names the other task's CLI as the cause and leaves the decision to the user", () => {
		const message = refusedPackagedCliMessage(BUILD_DIR, ["dev3 (pid 300) — command: dev3 task move"]);
		expect(message).toContain(BUILD_DIR);
		expect(message).toContain("DIFFERENT task");
		expect(message).toContain("ten minutes");
		expect(message).toContain("pid 300");
		expect(message).toContain("Fix:");
	});

	it("names an invisible handle as the cause and the windows to close as the fix", () => {
		const killed = stuckBuildFolderMessage(BUILD_DIR, ["launcher (pid 100) — path"], null);
		expect(killed).toContain("Terminated this build's own processes first");
		expect(killed).toContain("Fix: close every dev-3.0 window");

		const nothingFound = stuckBuildFolderMessage(BUILD_DIR, [], null);
		expect(nothingFound).toContain("the handle belongs to something else");

		const blind = stuckBuildFolderMessage(BUILD_DIR, [], "tasklist attempt 2 timed out after 5001ms");
		expect(blind).toContain("this machine's OS process list, not the app");
		expect(blind).toContain("nothing was terminated");
		expect(blind).toContain("timed out after 5001ms");
		for (const message of [killed, nothingFound, blind]) {
			expect(message).toContain("Windows refuses to delete it");
			expect(message).toContain("Fix:");
		}
	});
});
