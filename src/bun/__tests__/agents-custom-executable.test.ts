import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, paths: null as unknown, pickId: null as string | null }));
vi.mock("../account-router", () => ({
	isAutoAccountDefault: vi.fn(async () => true),
	pickAutoAccount: vi.fn(async () => ({ accountId: state.pickId, reason: { code: "test" } })),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => state.settings),
	saveSettings: vi.fn(async () => undefined),
}));
vi.mock("../agent-accounts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../agent-accounts")>();
	return {
		...actual,
		getActiveClaudeSessionEnv: (id?: string | null) => actual.getActiveClaudeSessionEnv(id, state.paths as import("../agent-accounts").AccountPaths),
		claudeAccountRegistered: (id: string) => actual.claudeAccountRegistered(id, state.paths as import("../agent-accounts").AccountPaths),
	};
});

import { claudeAccountDir, prepareClaudeLogin, registerStagedClaudeAccount, importCurrentClaudeAccount, setActiveClaudeAccount, type AccountPaths } from "../agent-accounts";
import { resolveCommandForAgent, resolveCommandForProject } from "../agents";
import type { Project } from "../../shared/types";
import { DEV3_HOME } from "../paths";
import { resetStaleAgentPathNoticesForTests } from "../stale-agent-path";
import { setPushMessage } from "../rpc-handlers/shared-pure";

const ctx = { taskTitle: "t", taskDescription: "d", projectName: "p", projectPath: "/p", worktreePath: "/w" };
let root: string;
let wrapper: string;

beforeAll(() => mkdirSync(DEV3_HOME, { recursive: true }));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-custom-exe-"));
	state.paths = {
		accountsDir: join(root, "agent-accounts"),
		claudeHome: join(root, ".claude"),
		claudeJson: join(root, ".claude.json"),
		codexHome: join(root, ".codex"),
	} satisfies AccountPaths;
	wrapper = join(root, "my wrapper");
	writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
	chmodSync(wrapper, 0o755);
	state.settings = {
		agentsLayoutRevision: 10,
		defaultAgentId: "builtin-claude",
		agentBinaryPaths: {},
		agentCustomBinaryPaths: { "builtin-claude": wrapper },
	};
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("launch with a custom executable", () => {
	it("fails with the path in the message when the file is missing, without falling back to the system claude", async () => {
		const missing = join(root, "missing-wrapper");
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": missing }, strictAgentCustomBinaryPaths: { "builtin-claude": missing } };
		await expect(resolveCommandForAgent("builtin-claude", null, ctx)).rejects.toThrow(missing);
	});

	it("fails when the file is not executable", async () => {
		chmodSync(wrapper, 0o644);
		state.settings = { ...state.settings, strictAgentCustomBinaryPaths: { "builtin-claude": wrapper } };
		await expect(resolveCommandForAgent("builtin-claude", null, ctx)).rejects.toThrow(/not executable/);
	});

	it("runs the wrapper as Claude with each picked account's own CLAUDE_CONFIG_DIR", async () => {
		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		const a = registerStagedClaudeAccount((await prepareClaudeLogin(paths)).accountId, paths);
		const b = registerStagedClaudeAccount((await prepareClaudeLogin(paths)).accountId, paths);

		const first = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: a.id });
		const second = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: b.id });
		expect(first.command).toContain(wrapper);
		expect(first.agentFamily).toBe("claude");
		expect(first.extraEnv.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir(a.id, paths));
		expect(second.extraEnv.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir(b.id, paths));
	});

	it("fails the launch for an unknown account instead of running on the system login", async () => {
		await expect(resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "no-such-account" })).rejects.toThrow("Unknown Claude account: no-such-account");
	});

	it("fails the launch for a managed account whose login never completed", async () => {
		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: "m@example.com", accountUuid: "u" } }));
		writeFileSync(join(paths.claudeHome, ".credentials.json"), "{}");
		const managed = await importCurrentClaudeAccount(paths);
		rmSync(join(paths.accountsDir, "claude", managed.id, ".claude.json"));
		await expect(resolveCommandForAgent("builtin-claude", null, ctx, { accountId: managed.id })).rejects.toThrow(/not signed in/);
	});

	it("fails resolveCommandForProject for a broken custom path too", async () => {
		const missing = join(root, "missing-wrapper");
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": missing }, strictAgentCustomBinaryPaths: { "builtin-claude": missing } };
		const project = { name: "p", path: "/p" } as Project;
		await expect(resolveCommandForProject(project, "t", "d", "/w")).rejects.toThrow(missing);
	});
});

describe("a custom path saved before custom paths became strict", () => {
	beforeEach(() => resetStaleAgentPathNoticesForTests());

	it("launches the command from PATH when it is gone, and warns once with the path", async () => {
		const push = vi.fn();
		setPushMessage(push);
		const missing = join(root, "old-nvm", "claude");
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": missing }, agentBinaryPaths: { "builtin-claude": missing } };
		const first = await resolveCommandForAgent("builtin-claude", null, ctx);
		await resolveCommandForAgent("builtin-claude", null, ctx);
		expect(first.command).not.toContain(missing);
		expect(push.mock.calls.filter(([name]) => name === "staleAgentPath")).toEqual([
			["staleAgentPath", { agentId: "builtin-claude", agentName: expect.any(String), path: missing, command: "claude" }],
		]);
	});

	it("still fails when it was re-chosen in a strict build but the strict entry names another path", async () => {
		const missing = join(root, "missing-wrapper");
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": missing }, strictAgentCustomBinaryPaths: { "builtin-claude": missing } };
		await expect(resolveCommandForAgent("builtin-claude", null, ctx)).rejects.toThrow(missing);
	});

	it("is used as before while it still works", async () => {
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": wrapper } };
		expect((await resolveCommandForAgent("builtin-claude", null, ctx)).command).toContain(wrapper);
	});
});

describe("a stored account that was removed", () => {
	it("falls back to the default account and says so, when the id came from stored state", async () => {
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "removed-account", accountFromStore: true });
		expect(resolved.staleAccountDropped).toBe(true);
		expect(resolved.resolvedAccountId).toBeNull();
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
	});

	it("still follows an Auto default: the routed pick is used, not the registry default", async () => {
		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		const picked = registerStagedClaudeAccount((await prepareClaudeLogin(paths)).accountId, paths);
		state.pickId = picked.id;
		const routing = { exclusions: [], reservationKey: "k", claudeConfigPinned: false };
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "removed-account", accountFromStore: true, autoRouting: routing as never });
		expect(resolved.staleAccountDropped).toBe(true);
		expect(resolved.resolvedAccountId).toBe(picked.id);
		expect(resolved.accountPick?.accountId).toBe(picked.id);
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir(picked.id, paths));
	});

	it("still fails for the same id passed explicitly", async () => {
		await expect(resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "removed-account" })).rejects.toThrow("Unknown Claude account");
	});

	it("still fails for an existing account whose login never completed", async () => {
		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		const { accountId } = await prepareClaudeLogin(paths);
		const account = registerStagedClaudeAccount(accountId, paths);
		rmSync(claudeAccountDir(account.id, paths), { recursive: true });
		await expect(resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, accountFromStore: true })).rejects.toThrow(/config folder not found/);
	});
});

describe("a project that pins its own Claude folder", () => {
	async function defaultAccount() {
		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		const account = registerStagedClaudeAccount((await prepareClaudeLogin(paths)).accountId, paths);
		writeFileSync(join(claudeAccountDir(account.id, paths), ".claude.json"), "{}");
		await setActiveClaudeAccount(account.id, paths);
		state.pickId = account.id;
		return { account, dir: claudeAccountDir(account.id, paths) };
	}

	it("keeps the project folder over the default account", async () => {
		await defaultAccount();
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { claudeConfigPinned: true });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
		expect(resolved.resolvedAccountId).toBeUndefined();
	});

	it("keeps the project folder when Auto would route, on a fresh launch", async () => {
		await defaultAccount();
		const routing = { exclusions: [], reservationKey: "k", claudeConfigPinned: true };
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "auto", autoRouting: routing as never });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
		expect(resolved.accountPick).toBeUndefined();
	});

	it("still uses an account picked for the task", async () => {
		const { account, dir } = await defaultAccount();
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, claudeConfigPinned: true });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe(dir);
	});

	it("an unpinned project still gets the default account", async () => {
		const { dir } = await defaultAccount();
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx);
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe(dir);
	});
});
