/**
 * #1854: the setup wrappers used to run the setupScript as `<shell> -x setup.sh`.
 * zsh turns `-x` on BEFORE it sources `.zshenv` (bash likewise for `$BASH_ENV`),
 * so every credential a startup file exported was printed, expanded, into the
 * setup pane — and a `set +x` on the script's first line came too late.
 *
 * These run the real generated wrappers under a real shell with a disposable
 * HOME/ZDOTDIR whose startup file exports a fake marker, and assert the marker's
 * value never reaches the output while setup still runs and still reports.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER_VALUE = "fake-marker-4f1c9e-not-a-secret";

// One zsh and one bash, whichever install exists (CI's ubuntu has no zsh).
const SHELLS = [
	["/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh"].find((p) => existsSync(p)),
	["/bin/bash", "/usr/bin/bash"].find((p) => existsSync(p)),
].filter((p): p is string => p !== undefined);

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dev3-setup-trace-"));
	const startup = `export DEMO_SETUP_TOKEN=${MARKER_VALUE}\n`;
	writeFileSync(join(dir, ".zshenv"), startup);
	writeFileSync(join(dir, "bash_env"), startup);
	// A stand-in tmux: records that the wrapper asked for the agent pane.
	writeFileSync(join(dir, "tmux"), `#!/bin/sh\necho "$@" > '${dir}/tmux-called'\n`);
	chmodSync(join(dir, "tmux"), 0o755);
	writeFileSync(join(dir, "cmd.sh"), "echo AGENT-STARTED\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeSetup(body: string): string {
	const path = join(dir, "setup.sh");
	// The script proves the startup file DID load, so an absent value is not vacuous.
	writeFileSync(path, `set +x\necho "marker-length=\${#DEMO_SETUP_TOKEN}"\n${body}\n`);
	return path;
}

function runWrapper(shell: string, script: string) {
	const wrapperPath = join(dir, "wrapper.sh");
	writeFileSync(wrapperPath, script);
	const res = spawnSync(shell, [wrapperPath], {
		cwd: dir,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 20_000,
		env: {
			PATH: `${dir}:/usr/bin:/bin`,
			HOME: dir,
			ZDOTDIR: dir,
			BASH_ENV: join(dir, "bash_env"),
			TERM: "dumb",
		},
	});
	return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

const exitPath = () => join(dir, "setup-exit");

describe.skipIf(SHELLS.length === 0).each(SHELLS)("setup tracing never prints startup exports (%s)", (shell) => {
	// Control: proves the fixture exposes the value when the shell IS traced, so
	// the assertions below would catch `-x` coming back.
	it("the fixture leaks the marker under `-x` (control)", () => {
		const setupPath = writeSetup("true");
		const res = runWrapper(shell, `'${shell}' -x '${setupPath}'\n`);
		expect(res.output).toContain(MARKER_VALUE);
	});

	it("re-run: succeeds and reports without the marker", async () => {
		const { buildSetupRerunScript } = await import("../rpc-handlers/shared-pure");
		const setupPath = writeSetup(`touch '${dir}/setup-ran'`);
		const res = runWrapper(shell, buildSetupRerunScript({ setupPath, shellPath: shell, setupExitPath: exitPath() }));

		expect(res.output).not.toContain(MARKER_VALUE);
		expect(res.output).toContain(`marker-length=${MARKER_VALUE.length}`);
		expect(res.output).toContain("✓ Setup done");
		expect(existsSync(join(dir, "setup-ran"))).toBe(true);
		expect(existsSync(exitPath())).toBe(false);
		expect(res.status).toBe(0);
	});

	it("re-run: a failing setup still records its exit code", async () => {
		const { buildSetupRerunScript } = await import("../rpc-handlers/shared-pure");
		const setupPath = writeSetup("exit 7");
		const res = runWrapper(shell, buildSetupRerunScript({ setupPath, shellPath: shell, setupExitPath: exitPath() }));

		expect(res.output).not.toContain(MARKER_VALUE);
		expect(res.output).toContain("✗ Setup failed (exit 7)");
		expect(readFileSync(exitPath(), "utf-8")).toBe("7");
	});

	const MODES = [
		{ name: "native", nativeBackend: true, launchMode: "parallel" as const },
		{ name: "tmux parallel", nativeBackend: false, launchMode: "parallel" as const },
		{ name: "tmux blocking", nativeBackend: false, launchMode: "blocking" as const },
	];

	for (const mode of MODES) {
		it(`initial setup (${mode.name}): runs, hands over, never prints the marker`, async () => {
			const { buildSetupStartupWrapper } = await import("../rpc-handlers/shared-pure");
			const setupPath = writeSetup(`touch '${dir}/setup-ran'`);
			const res = runWrapper(shell, buildSetupStartupWrapper({
				setupPath,
				cmdPath: join(dir, "cmd.sh"),
				worktreePath: dir,
				shellPath: shell,
				nativeBackend: mode.nativeBackend,
				launchMode: mode.launchMode,
				setupExitPath: exitPath(),
			}));

			expect(res.output).not.toContain(MARKER_VALUE);
			expect(res.output).toContain(`marker-length=${MARKER_VALUE.length}`);
			expect(res.output).toContain("✓ Setup done");
			expect(existsSync(join(dir, "setup-ran"))).toBe(true);
			if (mode.nativeBackend) expect(res.output).toContain("AGENT-STARTED");
			else expect(readFileSync(join(dir, "tmux-called"), "utf-8")).toContain("split-window");
		});

		it(`initial setup (${mode.name}): a failing setup records its exit code`, async () => {
			const { buildSetupStartupWrapper } = await import("../rpc-handlers/shared-pure");
			const setupPath = writeSetup("exit 3");
			const res = runWrapper(shell, buildSetupStartupWrapper({
				setupPath,
				cmdPath: join(dir, "cmd.sh"),
				worktreePath: dir,
				shellPath: shell,
				nativeBackend: mode.nativeBackend,
				launchMode: mode.launchMode,
				setupExitPath: exitPath(),
			}));

			expect(res.output).not.toContain(MARKER_VALUE);
			expect(res.output).toContain("✗ Setup failed (exit 3)");
			expect(readFileSync(exitPath(), "utf-8")).toBe("3");
		});
	}
});
