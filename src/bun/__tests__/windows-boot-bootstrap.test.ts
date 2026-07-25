/**
 * The Windows boot path up to the first window: home resolution, the CLI
 * transport seam, the shell default, and the shell-free dev/start command chain.
 *
 * Everything asserted here runs BEFORE a window exists, so a regression is not a
 * degraded feature — it is an app that never draws.
 */

import { describe, expect, it } from "vitest";

import { resolveUserHome } from "../../shared/user-home";
import { cliSocketTransportSupported } from "../../shared/cli-socket-transport";
import { WINDOWS_POWERSHELL_FALLBACK, defaultLaunchShellPath } from "../../shared/platform-launch";
import { descendantPids, devPlan, devRunEnv, parseProcessTable, shutdownSignals, treeKillCommand } from "../../../scripts/dev";
import { cliBinaryName, cliCopyEntry } from "../../../electrobun.config";
import { emitsUpdateArchive } from "../../shared/electrobun-build-env";
import { findEnvPathKey, normalizeEnvPath, readEnvPath } from "../../shared/env-path";
import { getSystemRequirements } from "../../shared/system-requirements";

const fakeOs = (home: string, tmp = "/fallback-tmp") => ({ homedir: () => home, tmpdir: () => tmp });

describe("resolveUserHome", () => {
	it("prefers $HOME so POSIX and every HOME-overriding test are unchanged", () => {
		expect(resolveUserHome({ HOME: "/Users/arseny" }, fakeOs("/ignored"))).toBe("/Users/arseny");
	});

	it("falls back to %USERPROFILE% on Windows, where $HOME is undefined", () => {
		expect(resolveUserHome({ USERPROFILE: "C:\\Users\\arseny" }, fakeOs("C:\\ignored")))
			.toBe("C:/Users/arseny");
	});

	it("falls back to homedir() when neither env var is set", () => {
		expect(resolveUserHome({}, fakeOs("C:\\Users\\ci"))).toBe("C:/Users/ci");
	});

	it("never yields the old /tmp guess for a Windows profile", () => {
		expect(resolveUserHome({ USERPROFILE: "C:\\Users\\a" }, fakeOs("C:\\x"))).not.toContain("/tmp");
	});

	it("normalises separators so string-concatenated paths stay consistent", () => {
		const home = resolveUserHome({ USERPROFILE: "C:\\Users\\a" }, fakeOs("C:\\x"));
		expect(`${home}/.dev3.0/logs`).toBe("C:/Users/a/.dev3.0/logs");
	});

	it("drops a trailing separator so the data root never doubles one", () => {
		expect(resolveUserHome({ HOME: "/Users/a/" }, fakeOs("/x"))).toBe("/Users/a");
		expect(resolveUserHome({ USERPROFILE: "C:\\" }, fakeOs("C:\\x"))).toBe("C:");
	});

	it("ignores whitespace-only values", () => {
		expect(resolveUserHome({ HOME: "   ", USERPROFILE: "C:\\Users\\a" }, fakeOs("C:\\x")))
			.toBe("C:/Users/a");
	});

	it("survives a platform whose homedir() throws", () => {
		const throwing = { homedir: () => { throw new Error("no home"); }, tmpdir: () => "/tmp" };
		expect(resolveUserHome({}, throwing)).toBe("/tmp");
	});
});

describe("cliSocketTransportSupported", () => {
	it("reports the Unix-socket transport present on POSIX", () => {
		expect(cliSocketTransportSupported("darwin")).toBe(true);
		expect(cliSocketTransportSupported("linux")).toBe(true);
	});

	it("reports it absent on Windows — the Seq 1296 seam", () => {
		expect(cliSocketTransportSupported("win32")).toBe(false);
	});
});

describe("defaultLaunchShellPath", () => {
	it("keeps the historical POSIX default", () => {
		expect(defaultLaunchShellPath("darwin", { SHELL: "/bin/zsh" })).toBe("/bin/zsh");
		expect(defaultLaunchShellPath("linux", {})).toBe("/bin/zsh");
	});

	it("resolves Windows PowerShell 5.1 from %SystemRoot%", () => {
		expect(defaultLaunchShellPath("win32", { SystemRoot: "C:\\Windows" }))
			.toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	});

	it("degrades to a PATH lookup instead of throwing during boot", () => {
		expect(defaultLaunchShellPath("win32", {})).toBe(WINDOWS_POWERSHELL_FALLBACK);
	});
});

describe("dev/start command chain", () => {
	it("runs every step through the Bun executable, never a PATH tool or shell", () => {
		const steps = devPlan("dev", "/usr/local/bin/bun");
		expect(steps.map((s) => s.command[0])).toEqual(Array(5).fill("/usr/local/bin/bun"));
		for (const step of steps) {
			expect(step.command.join(" ")).not.toMatch(/[&|;$]/);
		}
	});

	it("resolves vite and electrobun as files, since Windows has no bare executable", () => {
		const flat = devPlan("dev", "bun").map((s) => s.command.join(" "));
		expect(flat).toContain("bun node_modules/vite/bin/vite.js build");
		expect(flat).toContain("bun node_modules/electrobun/bin/electrobun.cjs build");
	});

	it("keeps the documented step order", () => {
		expect(devPlan("dev", "bun").map((s) => s.label)).toEqual([
			"build info",
			"changelog",
			"renderer bundle",
			"CLI + native build",
			"electrobun build",
		]);
	});

	it("skips the renderer bundle for `start`, which reuses the last dist/", () => {
		expect(devPlan("start", "bun").map((s) => s.label)).not.toContain("renderer bundle");
	});

	it("passes the dev env the old shell prefix passed inline", () => {
		expect(devRunEnv("dev", { staticCode: "code-1", port0: "4321" })).toEqual({
			DEV3_FRESH_START: "1",
			DEV3_REMOTE_STATIC_CODE: "code-1",
			DEV3_REMOTE_PORT: "4321",
		});
	});

	it("defaults the remote port to 0 like `${DEV3_PORT0:-0}` did", () => {
		expect(devRunEnv("dev", { staticCode: null, port0: undefined }).DEV3_REMOTE_PORT).toBe("0");
		expect(devRunEnv("dev", { staticCode: null, port0: "  " }).DEV3_REMOTE_PORT).toBe("0");
	});

	it("omits the access code when it could not be produced", () => {
		expect(devRunEnv("dev", { staticCode: null, port0: "0" })).not.toHaveProperty("DEV3_REMOTE_STATIC_CODE");
	});

	it("gives `start` only the fresh-start flag, as before", () => {
		expect(devRunEnv("start", { staticCode: "ignored", port0: "9" })).toEqual({ DEV3_FRESH_START: "1" });
	});
});

describe("bundled CLI name", () => {
	it("installs dev3.exe from the bundle on Windows and dev3 elsewhere", () => {
		expect(cliBinaryName("win32")).toBe("dev3.exe");
		expect(cliBinaryName("darwin")).toBe("dev3");
	});

	it("keeps the copy map and the boot-time install path in agreement", () => {
		for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
			const [, destination] = cliCopyEntry(platform);
			expect(destination).toBe(`cli/${cliBinaryName(platform)}`);
		}
	});
});

// Electrobun runs postPackage for `dev` too, where it emits no artifacts at all.
// Before this gate, `bun run dev` on Windows died inside the archive proof —
// after `electrobun build` had already succeeded — so the window never opened.
describe("update-archive proof gate", () => {
	it("skips the archive proof for the dev build, which emits no artifacts", () => {
		expect(emitsUpdateArchive("dev")).toBe(false);
	});

	it("keeps release builds strict", () => {
		expect(emitsUpdateArchive("canary")).toBe(true);
		expect(emitsUpdateArchive("stable")).toBe(true);
	});

	it("stays strict for an unset or unknown environment, never a silent no-op", () => {
		expect(emitsUpdateArchive(undefined)).toBe(true);
		expect(emitsUpdateArchive("prod")).toBe(true);
		expect(emitsUpdateArchive("")).toBe(true);
	});
});

// A real Windows run reported git as "not found" while git was installed and on
// the user's Path: process.env.PATH was undefined (SystemRoot read fine), so
// every binary lookup searched an empty path. Windows spells the variable `Path`.
describe("search PATH resolution", () => {
	it("reads the canonical POSIX spelling untouched", () => {
		expect(readEnvPath({ PATH: "/usr/bin:/bin" })).toBe("/usr/bin:/bin");
		expect(findEnvPathKey({ PATH: "/usr/bin" })).toBe("PATH");
	});

	it("finds the Windows `Path` spelling", () => {
		expect(readEnvPath({ Path: "C:\\Windows\\System32" })).toBe("C:\\Windows\\System32");
		expect(findEnvPathKey({ Path: "C:\\W" })).toBe("Path");
	});

	it("prefers an exact PATH over a case variant, so POSIX never changes meaning", () => {
		expect(readEnvPath({ PATH: "/exact", Path: "/variant" })).toBe("/exact");
	});

	it("reports no PATH rather than inventing one", () => {
		expect(readEnvPath({ SystemRoot: "C:\\Windows" })).toBeUndefined();
		expect(findEnvPathKey({})).toBeUndefined();
	});

	it("aliases a Windows Path onto PATH in place, so Bun.which and children see it", () => {
		const env: Record<string, string | undefined> = { Path: "C:\\Windows\\System32;C:\\git\\cmd" };
		expect(normalizeEnvPath(env)).toEqual({ outcome: "aliased", fromKey: "Path", length: env.Path!.length });
		expect(env.PATH).toBe("C:\\Windows\\System32;C:\\git\\cmd");
	});

	it("leaves a canonical environment completely alone", () => {
		const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
		expect(normalizeEnvPath(env)).toEqual({ outcome: "already-canonical" });
		expect(env.PATH).toBe("/usr/bin");
	});

	it("returns env key NAMES for diagnostics when there is no PATH at all", () => {
		const result = normalizeEnvPath({ SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\u" });
		expect(result).toEqual({ outcome: "missing", envKeys: ["SystemRoot", "USERPROFILE"] });
	});
});

// tmux cannot be installed on Windows, so a REQUIRED tmux made the requirements
// gate permanently unpassable — the app was reachable only up to that screen.
// App.tsx passes when every requirement is `installed || optional`.
describe("system requirements per platform", () => {
	it("keeps git required everywhere", () => {
		for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
			const git = getSystemRequirements(platform).find((r) => r.id === "git");
			expect(git?.optional).toBeFalsy();
		}
	});

	it("keeps tmux required on POSIX with the brew install command", () => {
		const tmux = getSystemRequirements("darwin").find((r) => r.id === "tmux");
		expect(tmux?.optional).toBeFalsy();
		expect(tmux?.installCommand).toBe("brew install h0x91b/dev3/tmux@3.6");
		expect(tmux?.brewInstallable).toBe(true);
	});

	it("marks tmux optional on Windows so the gate can pass, without hiding it", () => {
		const requirements = getSystemRequirements("win32");
		const tmux = requirements.find((r) => r.id === "tmux");
		expect(tmux).toBeDefined();
		expect(tmux?.optional).toBe(true);
		expect(tmux?.installCommand).toBeUndefined();
		expect(tmux?.brewInstallable).toBe(false);
		// The gate App.tsx applies, with only git present.
		const withGitFound = requirements.map((r) => ({ ...r, installed: r.id === "git" }));
		expect(withGitFound.every((r) => r.installed || r.optional)).toBe(true);
	});

	it("never offers a macOS-only install command on Windows", () => {
		for (const req of getSystemRequirements("win32")) {
			expect(req.installCommand ?? "").not.toMatch(/brew|xcode-select/);
			expect(req.brewInstallable).toBe(false);
		}
		expect(getSystemRequirements("win32").find((r) => r.id === "git")?.installCommand)
			.toBe("winget install --id Git.Git -e");
	});
});

// Inserting scripts/dev.ts as a parent process broke Ctrl+C on Windows: the
// parent died, the electrobun child and the app grandchild were orphaned, and the
// app kept writing into a console that had already printed a new prompt.
describe("dev-loop shutdown", () => {
	it("intercepts Ctrl+C and terminal close on POSIX", () => {
		expect(shutdownSignals("darwin")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
	});

	it("uses SIGBREAK instead of SIGHUP on Windows, which has no SIGHUP", () => {
		const signals = shutdownSignals("win32");
		expect(signals).toContain("SIGBREAK");
		expect(signals).not.toContain("SIGHUP");
	});

	it("kills the whole tree on Windows, since the app is a grandchild", () => {
		expect(treeKillCommand(4242, "win32", { SystemRoot: "C:\\Windows" })).toEqual([
			"C:\\Windows\\System32\\taskkill.exe", "/PID", "4242", "/T", "/F",
		]);
	});

	it("addresses taskkill through %SystemRoot%, never assuming PATH resolves it", () => {
		const command = treeKillCommand(1, "win32", { WINDIR: "D:\\Win" });
		expect(command?.[0]).toBe("D:\\Win\\System32\\taskkill.exe");
		// Last resort only when Windows tells us nothing about its own root.
		expect(treeKillCommand(1, "win32", {})?.[0]).toBe("taskkill");
	});

	it("needs no tree kill on POSIX, where Ctrl+C reaches the process group", () => {
		expect(treeKillCommand(1, "darwin")).toBeNull();
		expect(treeKillCommand(1, "linux")).toBeNull();
	});
});

// Signalling the direct child does NOT cascade — verified on macOS, where after
// SIGINT the electrobun CLI processes died while the app launcher and the app
// itself survived and kept logging into the console. So POSIX needs a real walk.
describe("POSIX process-tree walk", () => {
	const table = [
		"    1     0",
		"  100     1",
		"  200   100",
		"  300   200",
		"  301   200",
		"  400     1",
	].join("\n");

	it("parses `ps -Ao pid=,ppid=` output", () => {
		expect(parseProcessTable("  100     1\n  200   100")).toEqual([
			{ pid: 100, ppid: 1 },
			{ pid: 200, ppid: 100 },
		]);
	});

	it("drops header and malformed lines instead of producing NaN pids", () => {
		expect(parseProcessTable("PID PPID\n\n  \n  10    1\nbogus")).toEqual([{ pid: 10, ppid: 1 }]);
	});

	it("collects the whole subtree, deepest first and the root last", () => {
		const pids = descendantPids(parseProcessTable(table), 100);
		expect(pids[pids.length - 1]).toBe(100);
		expect(pids).toEqual(expect.arrayContaining([200, 300, 301]));
		expect(pids).not.toContain(400);
		expect(pids).not.toContain(1);
	});

	it("returns just the root when it has no children", () => {
		expect(descendantPids(parseProcessTable(table), 400)).toEqual([400]);
	});

	it("cannot loop on a self-parenting or cyclic row", () => {
		expect(descendantPids([{ pid: 7, ppid: 7 }], 7)).toEqual([7]);
		expect(descendantPids([{ pid: 8, ppid: 9 }, { pid: 9, ppid: 8 }], 8).sort()).toEqual([8, 9]);
	});
});
