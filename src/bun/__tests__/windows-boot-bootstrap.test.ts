/**
 * The Windows boot path up to the first window: home resolution, the CLI
 * transport seam, the shell default, and the shell-free dev/start command chain.
 *
 * Everything asserted here runs BEFORE a window exists, so a regression is not a
 * degraded feature — it is an app that never draws.
 */

import { describe, expect, it } from "vitest";

import { resolveUserHome } from "../paths";
import { cliSocketTransportSupported } from "../../shared/cli-socket-transport";
import { WINDOWS_POWERSHELL_FALLBACK, defaultLaunchShellPath } from "../../shared/platform-launch";
import { devPlan, devRunEnv } from "../../../scripts/dev";
import { cliBinaryName, cliCopyEntry } from "../../../electrobun.config";
import { emitsUpdateArchive } from "../../shared/electrobun-build-env";

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
