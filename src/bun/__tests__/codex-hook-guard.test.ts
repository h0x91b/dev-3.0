/**
 * The Codex status hooks live in the user's `~/.codex/config.toml`, so Codex
 * fires them in every session on the machine — including workspaces that have
 * nothing to do with dev3 (h0x91b/dev-3.0#1527). What keeps that free is the env
 * guard in the generated command, and a guard is only worth what a real shell
 * does with it: these tests run the exact generated string through `/bin/sh`,
 * with a stand-in CLI that records being called.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCodexHooks, codexHookCommand } from "../../shared/agent-hooks";
import { buildDev3CodexHooksBlock } from "../codex-config";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("Codex hook command guard (executed through a real shell)", () => {
	let dir: string;
	let fakeCli: string;
	let marker: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dev3-codex-hook-"));
		fakeCli = join(dir, "dev3");
		marker = join(dir, "was-called");
		writeFileSync(fakeCli, `#!/bin/sh\necho "$@" > ${marker}\n`, "utf-8");
		chmodSync(fakeCli, 0o755);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const dialect = () => ({ cli: fakeCli, posixShell: true });

	/** Run the generated command the way Codex does: one string, through a shell. */
	const runHook = (env: Record<string, string>) => {
		const command = codexHookCommand(dialect());
		return spawnSync("/bin/sh", ["-c", command], {
			env: { PATH: process.env.PATH ?? "", ...env },
			encoding: "utf-8",
		});
	};

	it("does not launch dev3 at all in a session that is not a dev3 task", () => {
		const result = runHook({});
		expect(existsSync(marker)).toBe(false);
		// A non-zero hook exit is a failure Codex shows the user, and 2 blocks the
		// tool call outright — skipping has to be silent and successful.
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	it("still launches dev3 inside a dev3 task", () => {
		const result = runHook({ DEV3_TASK_ID: "task-1234" });
		expect(existsSync(marker)).toBe(true);
		expect(result.status).toBe(0);
	});

	it("treats an empty DEV3_TASK_ID as no task", () => {
		runHook({ DEV3_TASK_ID: "" });
		expect(existsSync(marker)).toBe(false);
	});

	it("guards every event dev3 declares, not just one", () => {
		const commands = Object.values(buildCodexHooks({ dialect: dialect() }))
			.flat()
			.flatMap((group) => group.hooks.map((hook) => hook.command));
		expect(commands).toHaveLength(6);
		for (const command of commands) {
			expect(command).toContain('[ -z "$DEV3_TASK_ID" ]');
		}
	});

	it("survives the trip through TOML: the block Codex reads still guards", () => {
		// The command is written into config.toml as a basic string, so the quotes
		// around $DEV3_TASK_ID are escaped there; what Codex runs is the decoded form.
		const block = buildDev3CodexHooksBlock({ dialect: dialect() });
		const encoded = block
			.split("\n")
			.filter((line) => line.startsWith("command = "))
			.map((line) => JSON.parse(line.slice("command = ".length)) as string);
		expect(encoded).toHaveLength(6);
		for (const command of encoded) {
			const result = spawnSync("/bin/sh", ["-c", command], {
				env: { PATH: process.env.PATH ?? "" },
				encoding: "utf-8",
			});
			expect(result.status).toBe(0);
		}
		expect(existsSync(marker)).toBe(false);
	});
});

describe("Codex hook command on Windows", () => {
	it("stays a bare command", () => {
		// The Windows hook runner is cmd.exe OR PowerShell depending on the session
		// shell, and no single guard expression is valid in both. The leak stays open
		// there on purpose; a guard that fails would cost every Windows dev3 task its
		// status moves.
		expect(codexHookCommand({ cli: '"C:/dev3/dev3.exe"', posixShell: false })).toBe(
			'"C:/dev3/dev3.exe" hook codex',
		);
	});
});
