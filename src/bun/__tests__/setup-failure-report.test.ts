/**
 * A `setupScript` runs inside the pane, so its exit code never reaches bun on
 * its own. These cover the whole channel that replaces that missing return
 * value: the wrapper's fail branch writes the code to a file, and the launching
 * app watches that file itself.
 *
 * The channel used to end in `dev3 hook setup-failed`. It never fired once in
 * the wild: `~/.dev3.0/bin/dev3` is rewritten by whichever instance launched
 * last, and its socket resolves to any live app rather than the one that owns
 * the task, so the ping reached a build that had never heard of the method.
 * Nothing shells out now — hence the assertions that it does not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER_ARGS = {
	setupPath: "/tmp/dev3-T-setup.sh",
	cmdPath: "/tmp/dev3-T-cmd.sh",
	worktreePath: "/w/t",
	shellPath: "/bin/zsh",
	setupExitPath: "/tmp/dev3-T-setup-exit",
};

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const real = process.platform;
	const realSystemRoot = process.env.SystemRoot;
	Object.defineProperty(process, "platform", { value: platform, writable: true });
	// Without it PowerShell 5.1 cannot be located at all and the builder throws.
	if (platform === "win32") process.env.SystemRoot = "C:\\Windows";
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", { value: real, writable: true });
		if (realSystemRoot === undefined) delete process.env.SystemRoot;
		else process.env.SystemRoot = realSystemRoot;
	}
}

describe("setup wrapper — recording a failed setupScript", () => {
	it("writes the exit code before dropping to a shell", async () => {
		const { buildSetupStartupWrapper } = await import("../rpc-handlers/shared-pure");
		const script = buildSetupStartupWrapper({ ...WRAPPER_ARGS, nativeBackend: true, launchMode: "parallel" });
		const lines = script.split("\n").map((l) => l.trim());

		const write = lines.findIndex((l) => l === `printf '%s' "$S" > '/tmp/dev3-T-setup-exit'`);
		const shell = lines.findIndex((l) => l === "exec '/bin/zsh'");

		expect(write).toBeGreaterThan(-1);
		// The exec never returns, so the write has to come first.
		expect(shell).toBeGreaterThan(write);
	});

	it("never shells out to the dev3 CLI", async () => {
		const { buildSetupStartupWrapper } = await import("../rpc-handlers/shared-pure");
		const script = buildSetupStartupWrapper({ ...WRAPPER_ARGS, nativeBackend: true, launchMode: "parallel" });
		expect(script).not.toContain("setup-failed");
		expect(script).not.toContain("bin/dev3");
	});

	it("records nothing on the success path", async () => {
		const { buildSetupStartupWrapper } = await import("../rpc-handlers/shared-pure");
		const script = buildSetupStartupWrapper({ ...WRAPPER_ARGS, nativeBackend: true, launchMode: "parallel" });
		const afterFailBranch = script.slice(script.indexOf("✓ Setup done"));
		expect(afterFailBranch).not.toContain("dev3-T-setup-exit");
	});

	// Windows has no `printf ... >`, and PowerShell 5.1's `>` would write UTF-16LE.
	// Assert the PowerShell spelling, not just that "some" recording happens.
	it("uses the PowerShell spelling on win32", async () => {
		const { buildSetupStartupWrapper } = await import("../rpc-handlers/shared-pure");
		const script = withPlatform("win32", () =>
			buildSetupStartupWrapper({ ...WRAPPER_ARGS, nativeBackend: true, launchMode: "parallel" }),
		);
		expect(script).toContain("[System.IO.File]::WriteAllText('/tmp/dev3-T-setup-exit', [string]$S)");
	});
});

// ---- The watcher ----

describe("watchSetupFailure", () => {
	let dir: string;
	let watch: typeof import("../setup-failure-watch");
	const TASK = "task-1";

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "dev3-setup-watch-"));
		process.env.DEV3_TEST_ROOT = dir;
		vi.resetModules();
		watch = await import("../setup-failure-watch");
	});

	afterEach(() => {
		watch.stopSetupFailureWatch(TASK);
		delete process.env.DEV3_TEST_ROOT;
		rmSync(dir, { recursive: true, force: true });
	});

	const exitPath = () => join(dir, `dev3-${TASK}-setup-exit`);
	const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

	it("reports the recorded code once the file appears", async () => {
		const seen: number[] = [];
		watch.watchSetupFailure(TASK, (code) => void seen.push(code), { intervalMs: 5 });

		await settle();
		expect(seen).toEqual([]); // nothing written yet — silence, not a false alarm

		writeFileSync(exitPath(), "127");
		await settle();
		expect(seen).toEqual([127]);
	});

	it("stops after reporting, so one failure cannot fire twice", async () => {
		const seen: number[] = [];
		watch.watchSetupFailure(TASK, (code) => void seen.push(code), { intervalMs: 5 });
		writeFileSync(exitPath(), "3");
		await settle();
		await settle();

		expect(seen).toEqual([3]);
		expect(watch.watchedSetupFailureTasks()).toEqual([]);
	});

	it("ignores a half-written file instead of reporting a wrong code", async () => {
		const seen: number[] = [];
		watch.watchSetupFailure(TASK, (code) => void seen.push(code), { intervalMs: 5 });
		writeFileSync(exitPath(), "");
		await settle();
		expect(seen).toEqual([]);

		writeFileSync(exitPath(), "9");
		await settle();
		expect(seen).toEqual([9]);
	});

	it("replaces a previous watch for the same task", async () => {
		const first: number[] = [];
		const second: number[] = [];
		watch.watchSetupFailure(TASK, (c) => void first.push(c), { intervalMs: 5 });
		watch.watchSetupFailure(TASK, (c) => void second.push(c), { intervalMs: 5 });
		writeFileSync(exitPath(), "5");
		await settle();

		expect(first).toEqual([]);
		expect(second).toEqual([5]);
	});

	it("stops watching on request", async () => {
		const seen: number[] = [];
		watch.watchSetupFailure(TASK, (c) => void seen.push(c), { intervalMs: 5 });
		watch.stopSetupFailureWatch(TASK);
		writeFileSync(exitPath(), "4");
		await settle();

		expect(seen).toEqual([]);
	});

	it("gives up after the deadline rather than polling forever", async () => {
		const seen: number[] = [];
		watch.watchSetupFailure(TASK, (c) => void seen.push(c), { intervalMs: 5, maxMs: 10 });
		await settle();
		expect(watch.watchedSetupFailureTasks()).toEqual([]);

		writeFileSync(exitPath(), "6");
		await settle();
		expect(seen).toEqual([]);
	});

	it("treats a garbled or zero code as a plain failure", async () => {
		expect(watch.parseSetupExitCode("127")).toBe(127);
		expect(watch.parseSetupExitCode(" 8 \n")).toBe(8);
		// A wrapper that reached the fail branch did fail, whatever the file says.
		expect(watch.parseSetupExitCode("0")).toBe(1);
		expect(watch.parseSetupExitCode("wat")).toBe(1);
	});
});
