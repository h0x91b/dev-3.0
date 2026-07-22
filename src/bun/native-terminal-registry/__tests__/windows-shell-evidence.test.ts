import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Check {
	id: string;
	passed: boolean;
	detail: string;
}

interface RequiredShellEvidence {
	shell: string;
	detected: boolean;
	supported: boolean;
	version: string;
	checks: Check[];
	launch: {
		executable: string;
		argvEntries: number;
		cwdHasSpaces: boolean;
		cwdHasUnicode: boolean;
	};
	pids: {
		host: number;
		shell: number;
		reattachedShell: number;
		ownedChild: number;
	};
	exit: {
		kind: string;
		code: number;
		requested: number;
	};
}

interface WindowsShellEvidence {
	schemaVersion: number;
	capturedAt: string;
	platform: string;
	bunVersion: string;
	passed: boolean;
	checks: Check[];
	required: RequiredShellEvidence[];
	optional: Record<string, { detected: boolean; version: string; reason: string }>;
	scope: {
		registryOnly: boolean;
		tmuxInvoked: boolean;
		staticGuard: string;
	};
}

const evidence = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("./windows-shell-verdict-72e2ddcb.json", import.meta.url)),
		"utf8",
	),
) as WindowsShellEvidence;

const REQUIRED_CHECKS = [
	"shell-version",
	"launch-command",
	"probe-ready",
	"cwd",
	"environment",
	"argv",
	"root-pid",
	"state-set",
	"owned-child",
	"owned-boundary",
	"detach-complete",
	"same-pid",
	"same-state",
	"stop",
	"owned-teardown",
	"exit-probe-ready",
	"exit-code",
];

describe("native Windows shell evidence at 72e2ddcb", () => {
	it("records a passing Windows x64 run on packaged Bun 1.3.14", () => {
		expect(evidence).toMatchObject({
			schemaVersion: 1,
			capturedAt: "2026-07-22T23:42:02.0012866+03:00",
			platform: "win32 x64",
			bunVersion: "1.3.14",
			passed: true,
		});
		expect(evidence.checks.every((check) => check.passed)).toBe(true);
		expect(evidence.checks.map((check) => check.id).sort()).toEqual(
			["bun-version", "executable-not-found", "tmux-never-invoked"].sort(),
		);
	});

	it("proves every required shell lifecycle and exact failure exit", () => {
		expect(evidence.required.map((entry) => entry.shell).sort()).toEqual(
			["cmd", "powershell-7", "windows-powershell-5.1"],
		);

		for (const shell of evidence.required) {
			expect(shell.detected).toBe(true);
			expect(shell.supported).toBe(true);
			expect(shell.checks.every((check) => check.passed)).toBe(true);
			expect(shell.checks.map((check) => check.id).sort()).toEqual([...REQUIRED_CHECKS].sort());
			expect(shell.checks.find((check) => check.id === "owned-boundary")?.detail).toContain(
				"true/true/true",
			);
			expect(shell.launch).toMatchObject({
				argvEntries: 3,
				cwdHasSpaces: true,
				cwdHasUnicode: true,
			});
			expect(shell.pids.reattachedShell).toBe(shell.pids.shell);
			expect(shell.exit).toEqual({ kind: "shell-command-failed", code: 37, requested: 37 });
		}
	});

	it("records optional shells honestly and keeps production tmux out of scope", () => {
		expect(evidence.optional["git-bash"]).toMatchObject({
			detected: true,
			reason: "optional target detected but intentionally skipped",
		});
		expect(evidence.optional.wsl).toMatchObject({
			detected: true,
			reason: "optional target detected but intentionally skipped",
		});
		expect(evidence.scope).toEqual({
			registryOnly: true,
			tmuxInvoked: false,
			staticGuard: "src/bun/native-terminal-registry/__tests__/isolation.test.ts",
		});
	});
});
