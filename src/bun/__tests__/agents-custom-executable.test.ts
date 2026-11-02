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

import { claudeAccountDir, prepareClaudeLogin, registerStagedClaudeAccount, importCurrentClaudeAccount, type AccountPaths } from "../agent-accounts";
import { resolveCommandForAgent, resolveCommandForProject } from "../agents";
import type { Project } from "../../shared/types";
import { DEV3_AGENT_ACCOUNT_ID_ENV } from "../../shared/agent-accounts";
import { DEV3_HOME } from "../paths";

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
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": missing } };
		await expect(resolveCommandForAgent("builtin-claude", null, ctx)).rejects.toThrow(missing);
	});

	it("fails when the file is not executable", async () => {
		chmodSync(wrapper, 0o644);
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
		expect(first.extraEnv[DEV3_AGENT_ACCOUNT_ID_ENV]).toBe(a.id);
		expect(second.extraEnv.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir(b.id, paths));
		expect(second.extraEnv[DEV3_AGENT_ACCOUNT_ID_ENV]).toBe(b.id);
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
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": missing } };
		const project = { name: "p", path: "/p" } as Project;
		await expect(resolveCommandForProject(project, "t", "d", "/w")).rejects.toThrow(missing);
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
