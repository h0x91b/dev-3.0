import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertTaskWorkspacePresent, TaskWorkspaceUnavailableError, worktreeAccessState } from "../task-workspace-guard";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dev3-guard-")); });
afterEach(() => {
	try { chmodSync(join(root, "locked"), 0o755); } catch { /* not created by this test */ }
	rmSync(root, { recursive: true, force: true });
});

describe("worktreeAccessState", () => {
	it("present for a directory, with a .git link when git is required", () => {
		const wt = join(root, "wt");
		mkdirSync(wt);
		expect(worktreeAccessState(wt)).toBe("present");
		expect(worktreeAccessState(wt, { requireGit: true })).toBe("missing");
		writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
		expect(worktreeAccessState(wt, { requireGit: true })).toBe("present");
	});

	it("missing for a path that is not there, or not a directory", () => {
		expect(worktreeAccessState(join(root, "nope"))).toBe("missing");
		writeFileSync(join(root, "file"), "x");
		expect(worktreeAccessState(join(root, "file"))).toBe("missing");
	});

	// S6: lost Full Disk Access makes an intact worktree unreadable. That must never
	// read as "gone", or the UI would offer to reset live work.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unreadable — not missing — on a permission error", () => {
		const locked = join(root, "locked");
		const wt = join(locked, "wt");
		mkdirSync(wt, { recursive: true });
		chmodSync(locked, 0o000);
		expect(worktreeAccessState(wt)).toBe("unreadable");
		expect(() => assertTaskWorkspacePresent({ kind: undefined }, wt)).toThrow(/permission denied/);
	});
});

describe("assertTaskWorkspacePresent", () => {
	it("returns the path when usable, requiring .git only for git projects", () => {
		const wt = join(root, "wt");
		mkdirSync(wt);
		expect(assertTaskWorkspacePresent({ kind: "virtual" }, wt)).toBe(wt);
		expect(() => assertTaskWorkspacePresent({ kind: undefined }, wt)).toThrow(TaskWorkspaceUnavailableError);
	});

	it("refuses no recorded path and a missing one, naming what to do", () => {
		expect(() => assertTaskWorkspacePresent({ kind: undefined }, null)).toThrow(TaskWorkspaceUnavailableError);
		expect(() => assertTaskWorkspacePresent({ kind: undefined }, join(root, "gone"))).toThrow(/missing.*To Do to reset it, or cancel it/);
	});
});

// Structural half of the launcher-coverage test; behaviour is proven per launcher
// in rpc-handlers.test.ts / cli-socket-handlers.test.ts where a double exists. It
// pins the KNOWN launchers: each calls the guard, before its first trust write or
// spawn. It cannot detect a brand-new launcher — the tmux backstop covers that.
describe("every task-scoped launcher calls the guard", () => {
	const SRC = resolve(import.meta.dirname, "..");
	const LAUNCHERS: Array<[file: string, fn: string]> = [
		["rpc-handlers/tmux-pty.ts", "export async function launchTaskPty("],
		["rpc-handlers/tmux-pty.ts", "export async function launchColumnAgent("],
		["rpc-handlers/tmux-pty.ts", "async function startOneDevServer("],
		["rpc-handlers/tmux-pty.ts", "async function spawnAgentInTask("],
		["rpc-handlers/tmux-pty.ts", "async function spawnSingleBugHunterPane("],
		["rpc-handlers/tmux-pty.ts", "async function openFileBrowser("],
		["rpc-handlers/tmux-pty.ts", "async function rerunSetupScript("],
		["rpc-handlers/tmux-pty.ts", "async function getPtyUrl("],
		["rpc-handlers/task-panes.ts", "async function splitContext("],
		["rpc-handlers/scripts.ts", "async function runScriptHandler("],
		["cli-socket-server.ts", "\"pane.run\": async (params) => {"],
	];
	it.each(LAUNCHERS)("%s — %s", (file, signature) => {
		const source = readFileSync(join(SRC, file), "utf-8");
		const start = source.indexOf(signature);
		expect(start, `${signature} not found in ${file}`).toBeGreaterThanOrEqual(0);
		const next = source.slice(start + signature.length).search(/\n(export )?(async )?function |\n\t"[a-z]+\.[a-zA-Z]+": /);
		const body = source.slice(start, next < 0 ? undefined : start + signature.length + next);
		// Read-only probes allowed before the guard: `which yazi` (is the file browser installed?).
		const probed = body.slice(signature.length).replace('spawn(["which", "yazi"]', "");
		const guardAt = probed.indexOf("assertTaskWorkspacePresent(");
		expect(guardAt).toBeGreaterThanOrEqual(0);
		for (const sideEffect of ["ensureAgentTrust(", "applyAgentHooksToCommand(", "launchTaskPty(", "tmux.", "spawn(", "createSession(", "openAuxPane(", "startPaneRun(", "runScriptInTmux(", "writeLaunchScript("]) {
			const at = probed.indexOf(sideEffect);
			if (at >= 0) expect(at, `${sideEffect} runs before the guard in ${signature}`).toBeGreaterThan(guardAt);
		}
	});
});
