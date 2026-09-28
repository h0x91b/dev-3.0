/**
 * The task-level door to the Codex selection engine: which folder may be
 * scanned, which panes count as Codex, and how choices are claimed. Runs the
 * REAL engine against fixture stores under a temp $HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PaneSessionEntry, Project, Task } from "../../shared/types";
import { guardFsPromises, type FsRootGuard } from "./helpers/fs-root-guard";

// Real store discovery runs here: any path outside the fixture fails the test.
const fsGuard = vi.hoisted((): FsRootGuard => ({ roots: null, violations: [] }));
vi.mock("node:fs/promises", async (actual) => guardFsPromises(await actual<Record<string, unknown>>(), fsGuard));

const store = new Map<string, Task>();
vi.mock("../data", () => ({
	updateTaskWith: vi.fn(async (_project: Project, id: string, mutator: (task: Task) => { updates: Partial<Task>; result: unknown }) => {
		const current = store.get(id)!;
		const { updates, result } = await mutator(current);
		const next = { ...current, ...updates };
		store.set(id, next);
		return { task: next, result };
	}),
}));
vi.mock("../agents", () => ({
	getAllAgents: vi.fn(async () => [
		{ id: "builtin-codex", baseCommand: "codex", agentFamily: "codex", configurations: [] },
		{ id: "wrapped-codex", baseCommand: "~/bin/my-agent", agentFamily: "codex", configurations: [] },
		{ id: "builtin-claude", baseCommand: "claude", configurations: [] },
	]),
	findConfig: vi.fn((_agent: unknown, configId: string | null) => (configId === "custom-home" ? { id: configId, envVars: { CODEX_HOME: "custom-codex" } } : undefined)),
}));
vi.mock("../repo-config", () => ({ resolveProjectEnv: vi.fn(async () => ({})) }));
vi.mock("../git", () => ({ taskDir: vi.fn(() => `${process.env.HOME}/tasks/5a354452`) }));
vi.mock("../agent-accounts", () => ({ codexAccountIdForHome: vi.fn((home: string) => (home.includes("agent-accounts") ? home.split("/").pop() : undefined)) }));

import { chooseTaskCodexConversations, configuredCodexHomes, isCodexPane } from "../codex-task-selection";

let WT: string;
const ID = "00000000-0000-4000-8000-0000c0de1083";
const OTHER = "00000000-0000-4000-8000-0000c0de2704";
let home: string;
let savedHome: string | undefined;
let savedCodexHome: string | undefined;
let clock = Date.parse("2026-09-12T08:00:00Z") / 1000;

function conversation(root: string, id: string, cwd = WT): void {
	const path = join(root, "sessions", "2026", "09", "12", `rollout-x-${id}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "cli", timestamp: "2026-09-12T07:30:00.000Z" } })}\n`);
	clock += 60;
	utimesSync(path, clock, clock);
}
const project = { id: "p", kind: "git", path: "/repo" } as unknown as Project;
const codexPane = (overrides: Partial<PaneSessionEntry> = {}): PaneSessionEntry => ({ agentCmd: "codex", agentId: "builtin-codex", configId: "codex-default", sessionId: null, ...overrides });
function task(panes: PaneSessionEntry[], overrides: Partial<Task> = {}): Task {
	const t = { id: "t1", worktreePath: WT, lifecycleStartedAt: "2026-09-12T07:00:00.000Z", sessionState: { panes }, ...overrides } as unknown as Task;
	store.set(t.id, t);
	return t;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codex-task-selection-"));
	savedHome = process.env.HOME;
	process.env.HOME = home;
	// A developer shell may point CODEX_HOME at a real account store; never scan it.
	savedCodexHome = process.env.CODEX_HOME;
	delete process.env.CODEX_HOME;
	store.clear();
	WT = `${home}/tasks/5a354452/worktree`;
	mkdirSync(WT, { recursive: true });
	fsGuard.violations = [];
	fsGuard.roots = [home, realpathSync(home)];
});
afterEach(() => {
	process.env.HOME = savedHome;
	if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome;
	fsGuard.roots = null;
	rmSync(home, { recursive: true, force: true });
	expect(fsGuard.violations).toEqual([]);
});

describe("chooseTaskCodexConversations", () => {
	it("chooses and claims the worktree's conversation for an id-less pane", async () => {
		conversation(join(home, ".codex"), ID);
		const t = task([codexPane()]);
		const choices = await chooseTaskCodexConversations(project, t, t.sessionState!.panes, "explicit-resume", { persist: true });
		expect(choices.get(0)).toEqual({ sessionId: ID, codexHome: realpathSync(join(home, ".codex")) });
		expect(store.get("t1")!.sessionState!.panes[0]).toMatchObject({ sessionId: ID, accountId: null });
	});

	it("records the managed account of a newly chosen conversation", async () => {
		conversation(join(home, ".dev3.0", "agent-accounts", "codex", "acct-a"), ID);
		const t = task([codexPane()]);
		await chooseTaskCodexConversations(project, t, t.sessionState!.panes, "explicit-resume", { persist: true });
		expect(store.get("t1")!.sessionState!.panes[0]).toMatchObject({ sessionId: ID, accountId: "acct-a" });
	});

	it("scans nothing for an Operations task, even when its folder matches", async () => {
		conversation(join(home, ".codex"), ID);
		const t = task([codexPane()]);
		await expect(chooseTaskCodexConversations({ ...project, kind: "virtual" } as Project, t, t.sessionState!.panes, "explicit-resume", { persist: false }))
			.rejects.toThrow(/No Codex conversation/);
	});

	it("scans nothing when the task's folder is not its managed worktree", async () => {
		const shared = join(home, "Downloads");
		conversation(join(home, ".codex"), ID, shared);
		const t = task([codexPane()], { worktreePath: shared });
		await expect(chooseTaskCodexConversations(project, t, t.sessionState!.panes, "explicit-resume", { persist: false }))
			.rejects.toThrow(/No Codex conversation/);
	});

	it("fails the claim when the panes changed after the snapshot, writing nothing", async () => {
		conversation(join(home, ".codex"), ID);
		const t = task([codexPane()]);
		const snapshot = t.sessionState!.panes;
		store.set("t1", { ...t, sessionState: { panes: [codexPane({ sessionId: OTHER })] } });
		await expect(chooseTaskCodexConversations(project, t, snapshot, "explicit-resume", { persist: true })).rejects.toThrow(/changed while/);
		expect(store.get("t1")!.sessionState!.panes[0].sessionId).toBe(OTHER);
	});

	it("claims a rebuilt pane when nothing was stored (lost pane record)", async () => {
		conversation(join(home, ".codex"), ID);
		const t = task([]);
		await chooseTaskCodexConversations(project, t, [codexPane()], "explicit-resume", { persist: true, onDisk: [] });
		expect(store.get("t1")!.sessionState!.panes).toEqual([expect.objectContaining({ sessionId: ID })]);
	});

	it("does nothing for a task without Codex panes", async () => {
		const t = task([{ agentCmd: "claude", agentId: "builtin-claude", configId: null, sessionId: null }]);
		expect((await chooseTaskCodexConversations(project, t, t.sessionState!.panes, "explicit-resume", { persist: true })).size).toBe(0);
	});

	it("refuses automatic recovery, which needs real pane liveness the wrapper does not have", async () => {
		conversation(join(home, ".codex"), ID);
		const t = task([codexPane()]);
		await expect(chooseTaskCodexConversations(project, t, t.sessionState!.panes, "automatic-recovery" as never, { persist: false })).rejects.toThrow(/real pane liveness/);
	});

	it("uses the restart floor written on the task", async () => {
		conversation(join(home, ".codex"), ID);
		const t = task([codexPane()], { codexScanFloorAt: "2026-09-12T07:45:00.000Z" });
		await expect(chooseTaskCodexConversations(project, t, t.sessionState!.panes, "explicit-resume", { persist: false })).rejects.toThrow(/No Codex conversation/);
	});
});

describe("isCodexPane", () => {
	it("goes by the resolved agent, so a wrapper binary is still Codex", async () => {
		const agents = await (await import("../agents")).getAllAgents();
		expect(isCodexPane({ agentCmd: "~/bin/my-agent", agentId: "wrapped-codex", configId: null, sessionId: null }, agents)).toBe(true);
		expect(isCodexPane({ agentCmd: "codex", agentId: "builtin-claude", configId: null, sessionId: null }, agents)).toBe(false);
		expect(isCodexPane({ agentCmd: "codex", agentFamily: "codex", agentId: null, configId: null, sessionId: null }, agents)).toBe(true);
	});
});

describe("configuredCodexHomes", () => {
	it("resolves a relative custom home from the task working directory", async () => {
		const t = task([]);
		const agent = (await (await import("../agents")).getAllAgents())[0];
		expect(await configuredCodexHomes(project, t, agent, "custom-home")).toContain(`${WT}/custom-codex`);
	});
});
