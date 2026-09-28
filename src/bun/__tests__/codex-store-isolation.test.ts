/**
 * Proof that Codex store discovery in tests cannot reach a developer's real
 * store. A synthetic canary store stands in for the real one; the guarded
 * filesystem throws on any path outside the fixture root. The negative controls
 * show the guard fires when discovery IS pointed at the canary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PaneSessionEntry, Project, Task } from "../../shared/types";
import { guardFsPromises, type FsRootGuard } from "./helpers/fs-root-guard";

const inheritedAtLoad = vi.hoisted(() => process.env.CODEX_HOME);
const guard = vi.hoisted((): FsRootGuard => ({ roots: null, violations: [] }));
vi.mock("node:fs/promises", async (actual) => guardFsPromises(await actual<Record<string, unknown>>(), guard));

vi.mock("../data", () => ({ updateTaskWith: vi.fn(async (_p: Project, _id: string, mutator: (t: Task) => { updates: Partial<Task>; result: unknown }) => ({ task: {}, result: (await mutator(current)).result })) }));
vi.mock("../agents", () => ({
	getAllAgents: vi.fn(async () => [{ id: "builtin-codex", baseCommand: "codex", agentFamily: "codex", configurations: [] }]),
	findConfig: vi.fn(() => undefined),
}));
vi.mock("../repo-config", () => ({ resolveProjectEnv: vi.fn(async () => ({})) }));
vi.mock("../git", () => ({ taskDir: vi.fn(() => `${process.env.HOME}/tasks/5a354452`) }));
vi.mock("../agent-accounts", () => ({ codexAccountIdForHome: vi.fn(() => undefined) }));

import { chooseTaskCodexConversations } from "../codex-task-selection";
import { isInteractiveCodexConversation, selectCodexConversations } from "../codex-resume-home";

const ID = "0f0f0f0f-0000-4000-8000-00000000c0de";
let fixture: string;
let WT: string;
let canary: string;
let current: Task;
const project = { id: "p", kind: "git", path: "/repo" } as unknown as Project;
const pane: PaneSessionEntry = { agentCmd: "codex", agentId: "builtin-codex", configId: null, sessionId: null };

function rollout(root: string, id: string): void {
	const path = join(root, "sessions", "2026", "09", "28", `rollout-canary-${id}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: WT, source: "cli", timestamp: "2026-09-28T08:30:00.000Z" } })}\n`);
}
const arm = () => {
	guard.violations = [];
	guard.roots = [fixture, realpathSync(fixture)];
};

beforeEach(() => {
	fixture = mkdtempSync(join(tmpdir(), "codex-isolation-fixture-"));
	canary = mkdtempSync(join(tmpdir(), "codex-isolation-canary-"));
	process.env.HOME = fixture;
	WT = `${fixture}/tasks/5a354452/worktree`;
	mkdirSync(WT, { recursive: true });
	rollout(canary, ID);
	current = { id: "t", worktreePath: WT, lifecycleStartedAt: "2026-09-28T08:00:00.000Z", sessionState: { panes: [pane] } } as unknown as Task;
});
afterEach(() => {
	guard.roots = null;
	delete process.env.CODEX_HOME;
	rmSync(fixture, { recursive: true, force: true });
	rmSync(canary, { recursive: true, force: true });
});

describe("Codex store isolation in tests", () => {
	it("test isolation removed an inherited CODEX_HOME before this file loaded", () => {
		expect(inheritedAtLoad).toBeUndefined();
	});

	it("negative control: an inherited CODEX_HOME reaches discovery, and the guard stops it at the first touch", async () => {
		process.env.CODEX_HOME = canary;
		arm();
		// Discovery reports the refused store as unreadable and chooses nothing.
		await expect(chooseTaskCodexConversations(project, current, [pane], "explicit-resume", { persist: false })).rejects.toThrow(/Cannot read Codex session store/);
		expect(guard.violations.length).toBeGreaterThan(0);
		expect(guard.violations.every((v) => v.includes("codex-isolation-canary-"))).toBe(true);
	});

	it("negative control: the capture guard's lookup is stopped the same way", async () => {
		arm();
		expect(await isInteractiveCodexConversation(ID, [canary])).toBe(false);
		expect(guard.violations.some((v) => v.includes("codex-isolation-canary-"))).toBe(true);
	});

	it("negative control: an explicit store outside the fixture is stopped", async () => {
		arm();
		await expect(selectCodexConversations({
			intent: "explicit-resume", scanWorktree: WT, panes: [{ sessionId: null, live: false, resumeNow: true }],
			runBoundary: { lifecycleStartedAt: "2026-09-28T08:00:00.000Z", worktreeBirthMs: null, floorAt: null },
			additionalHomes: [canary],
		})).rejects.toThrow(/Cannot read Codex session store/);
		expect(guard.violations.length).toBeGreaterThan(0);
		expect(guard.violations.every((v) => v.includes("codex-isolation-canary-"))).toBe(true);
	});

	it("with CODEX_HOME cleared, the same selection touches nothing outside the fixture", async () => {
		rollout(join(fixture, ".codex"), ID);
		arm();
		const choices = await chooseTaskCodexConversations(project, current, [pane], "explicit-resume", { persist: false });
		expect(choices.get(0)?.sessionId).toBe(ID);
		expect(guard.violations).toEqual([]);
	});
});
