import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../codex-config", () => ({
	CODEX_HOOK_TRUST_BYPASS_FLAG: "--dangerously-bypass-hook-trust",
	detectCodexHookTrustBypass: vi.fn(async () => true),
	resetCodexHelpProbe: vi.fn(),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { setupAgentHooks } from "../agent-hooks";

let tempHome: string;
let folder: string;
let managed: string;
const originalDev3Home = process.env.DEV3_HOME;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "dev3-folder-home-"));
	folder = mkdtempSync(join(tmpdir(), "dev3-user-folder-"));
	managed = join(tempHome, "managed.json");
	writeFileSync(managed, JSON.stringify({ skipDangerousModePermissionPrompt: true, statusLine: { type: "command", command: "dev3 statusline" } }));
	process.env.DEV3_HOME = tempHome;
});

afterEach(() => {
	if (originalDev3Home === undefined) delete process.env.DEV3_HOME;
	else process.env.DEV3_HOME = originalDev3Home;
	rmSync(tempHome, { recursive: true, force: true });
	rmSync(folder, { recursive: true, force: true });
});

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, "utf-8"));
}

describe("setupAgentHooks in a folder dev3 does not own", () => {
	it("passes Claude's hooks in a --settings file and writes nothing into the folder", async () => {
		const launch = await setupAgentHooks(folder, "claude", {
			stopTarget: "review-by-user",
			permissionMode: "acceptEdits",
			claudeSettingsFile: managed,
		});

		expect(existsSync(join(folder, ".claude"))).toBe(false);
		expect(launch?.flag).toBeUndefined();
		const file = launch?.claudeSettingsFile ?? "";
		expect(file.startsWith(join(tempHome, "data", "agent-hooks"))).toBe(true);

		const settings = readJson(file);
		expect(settings.statusLine).toEqual({ type: "command", command: "dev3 statusline" });
		expect(settings.skipDangerousModePermissionPrompt).toBe(true);
		expect(settings.permissions.defaultMode).toBe("acceptEdits");
		expect(settings.permissions.allow.some((rule: string) => rule.includes("dev3"))).toBe(true);
		// Only a dev3 launch reads this file, so the hooks carry no env guard.
		const commands = JSON.stringify(settings.hooks);
		expect(commands).toContain("task move");
		expect(commands).not.toContain("DEV3_TASK_ID");
		// The edit tools claim their file, so two tasks in this folder cannot overwrite each other.
		const claim = settings.hooks.PreToolUse.find((group: { matcher?: string }) => group.matcher === "Edit|Write|MultiEdit|NotebookEdit");
		expect(claim.hooks[0].command).toContain("hook claude-claim");
	});

	it("gives different stop targets different files, so a live session's file never changes", async () => {
		const a = await setupAgentHooks(folder, "claude", { stopTarget: "review-by-user", claudeSettingsFile: managed });
		const b = await setupAgentHooks(folder, "claude", { stopTarget: "review-by-ai", claudeSettingsFile: managed });
		const again = await setupAgentHooks(folder, "claude", { stopTarget: "review-by-user", claudeSettingsFile: managed });
		expect(a?.claudeSettingsFile).not.toBe(b?.claudeSettingsFile);
		expect(again?.claudeSettingsFile).toBe(a?.claudeSettingsFile);
	});

	it("falls back to the folder's guarded settings when the command passes no managed file", async () => {
		const launch = await setupAgentHooks(folder, "claude", { stopTarget: "review-by-user" });
		expect(launch).toBeNull();
		const local = readJson(join(folder, ".claude", "settings.local.json"));
		expect(JSON.stringify(local.hooks)).toContain("DEV3_TASK_ID");
	});

	it("still writes a worktree's own settings file", async () => {
		const worktree = join(tempHome, "worktrees", "proj", "abcd1234", "worktree");
		mkdirSync(worktree, { recursive: true });
		const launch = await setupAgentHooks(worktree, "claude", { stopTarget: "review-by-user", claudeSettingsFile: managed });
		expect(launch).toBeNull();
		const local = readJson(join(worktree, ".claude", "settings.local.json"));
		// A worktree is one task's alone: nothing to claim.
		expect(JSON.stringify(local.hooks)).not.toContain("claude-claim");
	});

	it("leaves no Codex hooks file in the folder but keeps the trust flag", async () => {
		const launch = await setupAgentHooks(folder, "codex");
		expect(launch?.flag).toBe("--dangerously-bypass-hook-trust");
		expect(existsSync(join(folder, ".codex"))).toBe(false);
	});
});
