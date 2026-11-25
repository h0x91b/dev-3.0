import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
		claudeAccountSignedIntoDir: (id: string, dir: string) => actual.claudeAccountSignedIntoDir(id, dir, state.paths as import("../agent-accounts").AccountPaths),
		claudeAccountDir: (id: string, paths?: import("../agent-accounts").AccountPaths) => actual.claudeAccountDir(id, paths ?? (state.paths as import("../agent-accounts").AccountPaths)),
	};
});

import { claudeAccountDir, prepareClaudeLogin, registerStagedClaudeAccount, importCurrentClaudeAccount, setActiveClaudeAccount, type AccountPaths } from "../agent-accounts";
import { claudeLaunchKeepsProjectFolder, resolveClaudePickLaunch, resolveCommandForAgent, resolveCommandForProject } from "../agents";
import type { Project } from "../../shared/types";
import { ENV_UNSET } from "../../shared/agent-accounts";
import { DEV3_HOME } from "../paths";
import { claudeTranscriptDir } from "../../shared/conversation-search-core";
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
	it("fails when the file is missing or not executable, without falling back to the system claude, for project launches too", async () => {
		const missing = join(root, "missing-wrapper");
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": missing }, strictAgentCustomBinaryPaths: { "builtin-claude": missing } };
		await expect(resolveCommandForAgent("builtin-claude", null, ctx), "missing").rejects.toThrow(missing);
		await expect(resolveCommandForProject({ name: "p", path: "/p" } as Project, "t", "d", "/w"), "project launch").rejects.toThrow(missing);

		chmodSync(wrapper, 0o644);
		state.settings = { ...state.settings, agentCustomBinaryPaths: { "builtin-claude": wrapper }, strictAgentCustomBinaryPaths: { "builtin-claude": wrapper } };
		await expect(resolveCommandForAgent("builtin-claude", null, ctx), "not executable").rejects.toThrow(/not executable/);
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

	it("fails the launch for an unknown account, or one whose login never completed, instead of running on the system login", async () => {
		await expect(resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "no-such-account" })).rejects.toThrow("Unknown Claude account: no-such-account");

		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: "m@example.com", accountUuid: "u" } }));
		writeFileSync(join(paths.claudeHome, ".credentials.json"), "{}");
		const managed = await importCurrentClaudeAccount(paths);
		rmSync(join(paths.accountsDir, "claude", managed.id, ".claude.json"));
		await expect(resolveCommandForAgent("builtin-claude", null, ctx, { accountId: managed.id }), "login never completed").rejects.toThrow(/not signed in/);
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

	it("still fails for the same id passed explicitly, and for an existing account whose login never completed", async () => {
		await expect(resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "removed-account" }), "explicit id").rejects.toThrow("Unknown Claude account");

		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		const { accountId } = await prepareClaudeLogin(paths);
		const account = registerStagedClaudeAccount(accountId, paths);
		rmSync(claudeAccountDir(account.id, paths), { recursive: true });
		await expect(resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, accountFromStore: true }), "login never completed").rejects.toThrow(/config folder not found/);
	});
});

describe("a project that pins its own Claude folder", () => {
	const projectEnv = { CLAUDE_CONFIG_DIR: "/p/.claude", ANTHROPIC_MODEL: "project-model" };
	async function defaultAccount() {
		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		const account = registerStagedClaudeAccount((await prepareClaudeLogin(paths)).accountId, paths);
		writeFileSync(join(claudeAccountDir(account.id, paths), ".claude.json"), "{}");
		await setActiveClaudeAccount(account.id, paths);
		state.pickId = account.id;
		return { account, dir: claudeAccountDir(account.id, paths) };
	}

	it("keeps the project folder over the default account, without clearing or obeying the project's own ANTHROPIC_*", async () => {
		await defaultAccount();
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { projectEnv });
		// Set explicitly for panes that only get this env.
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe("/p/.claude");
		expect(resolved.resolvedAccountId).toBeUndefined();
		expect(resolved.extraEnv.ANTHROPIC_MODEL, "not cleared").toBeUndefined();
		expect(resolved.command, "does not steer --model").not.toContain("project-model");
	});

	it("keeps every sentinel under an explicit pick, so no project credential joins that login", async () => {
		const { account } = await defaultAccount();
		const env = { ...projectEnv, ANTHROPIC_AUTH_TOKEN: "gateway-token" };
		const picked = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, projectEnv: env });
		expect(picked.extraEnv.ANTHROPIC_MODEL).toBe(ENV_UNSET);
		expect(picked.extraEnv.ANTHROPIC_AUTH_TOKEN).not.toBe("gateway-token");
	});

	it("keeps the project folder when Auto would route, on a fresh launch", async () => {
		await defaultAccount();
		const routing = { exclusions: [], reservationKey: "k", claudeConfigPinned: true };
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "auto", autoRouting: routing as never, projectEnv });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe("/p/.claude");
		expect(resolved.accountPick).toBeUndefined();
	});

	it("keeps the project folder when the stored account was removed, and records no account", async () => {
		await defaultAccount();
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "removed-account", accountFromStore: true, projectEnv });
		expect(resolved.staleAccountDropped).toBe(true);
		expect(resolved.resolvedAccountId).toBeUndefined();
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe("/p/.claude");
	});

	it("still uses a picked account, an explicitly picked system login, and the default account for an unpinned project", async () => {
		const { account, dir } = await defaultAccount();
		const picked = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, projectEnv });
		expect(picked.extraEnv.CLAUDE_CONFIG_DIR, "picked account").toBe(dir);
		const system = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: null, projectEnv });
		expect(system.extraEnv.CLAUDE_CONFIG_DIR, "system login").toBe(ENV_UNSET);
		const unpinned = await resolveCommandForAgent("builtin-claude", null, ctx, { projectEnv: { ANTHROPIC_MODEL: "x" } });
		expect(unpinned.extraEnv.CLAUDE_CONFIG_DIR, "unpinned project").toBe(dir);
	});
});

describe("an account the project's own Claude folder is signed in to", () => {
	const login = (accountUuid: string, organizationUuid = "org-1") =>
		JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", accountUuid, organizationUuid } });
	let projectDir: string;
	let projectEnv: Record<string, string>;
	async function accountSignedInAs(accountUuid: string, organizationUuid?: string) {
		const paths = state.paths as AccountPaths;
		mkdirSync(paths.claudeHome, { recursive: true });
		const account = registerStagedClaudeAccount((await prepareClaudeLogin(paths)).accountId, paths);
		writeFileSync(join(claudeAccountDir(account.id, paths), ".claude.json"), login(accountUuid, organizationUuid));
		return { account, dir: claudeAccountDir(account.id, paths) };
	}
	beforeEach(() => {
		projectDir = join(root, "project", ".claude");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, ".claude.json"), login("person-1"));
		projectEnv = { CLAUDE_CONFIG_DIR: projectDir };
	});

	it("keeps the project folder on a fresh launch, records no account, and drops the project's Bedrock switch, model ids, credentials and base URL", async () => {
		const { account } = await accountSignedInAs("person-1");
		const env = {
			...projectEnv, CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_MODEL: "global.anthropic.x", ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.y", AWS_PROFILE: "p",
			ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_AUTH_TOKEN: "t",
		};
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, projectEnv: env });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe(projectDir);
		expect(resolved.projectLoginKept).toBe(true);
		expect(resolved.resolvedAccountId).toBeUndefined();
		expect(resolved.extraEnv.ANTHROPIC_BASE_URL, "project base URL").toBe(ENV_UNSET);
		expect(resolved.extraEnv.ANTHROPIC_AUTH_TOKEN, "project credentials").toBe(ENV_UNSET);
		expect(resolved.extraEnv.CLAUDE_CODE_USE_BEDROCK).toBe(ENV_UNSET);
		expect(resolved.extraEnv.ANTHROPIC_MODEL).toBe(ENV_UNSET);
		expect(resolved.extraEnv.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(ENV_UNSET);
		expect(resolved.extraEnv.AWS_PROFILE).toBeUndefined();
	});

	it("keeps the Bedrock env off when a pane launched on the project folder's login resumes", async () => {
		await accountSignedInAs("person-1");
		const env = { ...projectEnv, CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_MODEL: "global.anthropic.x" };
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { resume: true, accountFromStore: true, projectLogin: true, projectEnv: env });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe(projectDir);
		expect(resolved.projectLoginKept).toBe(true);
		expect(resolved.extraEnv.CLAUDE_CODE_USE_BEDROCK).toBe(ENV_UNSET);
		expect(resolved.extraEnv.ANTHROPIC_MODEL).toBe(ENV_UNSET);
	});

	it("leaves the project's Bedrock env alone when no account is picked", async () => {
		await accountSignedInAs("person-1");
		const env = { ...projectEnv, CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_MODEL: "global.anthropic.x" };
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { projectEnv: env });
		expect(resolved.extraEnv.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
		expect(resolved.extraEnv.ANTHROPIC_MODEL).toBeUndefined();
	});

	it("drops the project's Bedrock switch for a picked account in its own folder, Auto's pick, an explicit system login, and a project-default launch", async () => {
		const { account: other, dir: otherDir } = await accountSignedInAs("person-2");
		const ownFolder = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: other.id, projectEnv: { ...projectEnv, CLAUDE_CODE_USE_BEDROCK: "1" } });
		expect(ownFolder.extraEnv.CLAUDE_CONFIG_DIR, "picked account, own folder").toBe(otherDir);
		expect(ownFolder.extraEnv.CLAUDE_CODE_USE_BEDROCK, "picked account, own folder").toBe(ENV_UNSET);

		state.pickId = other.id;
		const routing = { exclusions: [], reservationKey: "k", claudeConfigPinned: false };
		const auto = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: "auto", autoRouting: routing as never, projectEnv: { CLAUDE_CODE_USE_BEDROCK: "1" } });
		expect(auto.accountPick?.accountId, "auto").toBe(other.id);
		expect(auto.extraEnv.CLAUDE_CODE_USE_BEDROCK, "auto").toBe(ENV_UNSET);

		const system = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: null, projectEnv: { CLAUDE_CODE_USE_BEDROCK: "1" } });
		expect(system.extraEnv.CLAUDE_CODE_USE_BEDROCK, "system login").toBe(ENV_UNSET);

		const { account } = await accountSignedInAs("person-1");
		const env = { ...projectEnv, CLAUDE_CODE_USE_BEDROCK: "1" };
		const fromProject = await resolveCommandForProject({ name: "p", path: "/p" } as Project, "t", "d", "/w", null, { accountId: account.id, projectEnv: env });
		expect(fromProject.projectLoginKept, "project default").toBe(true);
		expect(fromProject.extraEnv.CLAUDE_CODE_USE_BEDROCK, "project default").toBe(ENV_UNSET);
	});

	it("uses the account's own folder when the project folder is signed in to someone else, or the same person in another org", async () => {
		const { account, dir } = await accountSignedInAs("person-2");
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, projectEnv });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe(dir);
		expect(resolved.projectLoginKept).toBeUndefined();

		const { account: otherOrg, dir: otherOrgDir } = await accountSignedInAs("person-1", "org-2");
		const inOtherOrg = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: otherOrg.id, projectEnv });
		expect(inOtherOrg.extraEnv.CLAUDE_CONFIG_DIR, "same person, another org").toBe(otherOrgDir);
	});

	it("resumes in whichever folder the conversation was written to", async () => {
		const { account, dir } = await accountSignedInAs("person-1");
		const resumeS1 = () => resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, accountFromStore: true, resume: true, sessionId: "s-1", projectEnv });
		expect((await resumeS1()).extraEnv.CLAUDE_CONFIG_DIR, "account folder").toBe(dir);

		const store = claudeTranscriptDir(projectDir, ctx.worktreePath);
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "s-1.jsonl"), "{}\n");
		const inProject = await resumeS1();
		expect(inProject.extraEnv.CLAUDE_CONFIG_DIR, "project folder").toBe(projectDir);
		expect(inProject.projectLoginKept).toBe(true);
	});

	function transcript(configDir: string, name: string, ageSeconds: number) {
		const store = claudeTranscriptDir(configDir, ctx.worktreePath);
		mkdirSync(store, { recursive: true });
		const file = join(store, name);
		writeFileSync(file, "{}\n");
		const at = Date.now() / 1000 - ageSeconds;
		utimesSync(file, at, at);
	}

	it("continues in the project folder when it holds this worktree's newest conversation", async () => {
		const { account, dir } = await accountSignedInAs("person-1");
		transcript(dir, "old.jsonl", 600);
		transcript(projectDir, "s-2.jsonl", 10);
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, accountFromStore: true, resume: true, projectEnv });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe(projectDir);
	});

	it("continues in the account's folder when its conversation is newer than the project folder's", async () => {
		const { account, dir } = await accountSignedInAs("person-1");
		transcript(projectDir, "stale.jsonl", 600);
		transcript(dir, "latest.jsonl", 10);
		const resolved = await resolveCommandForAgent("builtin-claude", null, ctx, { accountId: account.id, accountFromStore: true, resume: true, projectEnv });
		expect(resolved.extraEnv.CLAUDE_CONFIG_DIR).toBe(dir);
		expect(resolved.projectLoginKept).toBeUndefined();
	});

	it("answers the resume guard with the same rule the launch uses", async () => {
		const { account } = await accountSignedInAs("person-1");
		transcript(projectDir, "s-3.jsonl", 10);
		const where = { projectEnv, projectPath: ctx.projectPath, worktreePath: ctx.worktreePath };
		expect(claudeLaunchKeepsProjectFolder(account.id, { ...where, resume: true, sessionId: "s-3" })).toBe(true);
		expect(claudeLaunchKeepsProjectFolder(account.id, { ...where, resume: true, sessionId: "elsewhere" })).toBe(false);
		const { account: other } = await accountSignedInAs("person-2");
		expect(claudeLaunchKeepsProjectFolder(other.id, { ...where, resume: true, sessionId: "s-3" })).toBe(false);
	});

	it("tells the picker where each pick runs, with the launch's own answer", async () => {
		const { account } = await accountSignedInAs("person-1");
		const { account: other } = await accountSignedInAs("person-2");
		transcript(projectDir, "s-4.jsonl", 10);
		const where = { projectEnv: { ...projectEnv, CLAUDE_CODE_USE_BEDROCK: "1" }, projectPath: ctx.projectPath, worktreePath: ctx.worktreePath };
		await expect(resolveClaudePickLaunch(undefined, where)).resolves.toEqual({ projectFolder: true, keepsProjectBackend: true });
		await expect(resolveClaudePickLaunch(null, where)).resolves.toEqual({ projectFolder: false, keepsProjectBackend: false });
		await expect(resolveClaudePickLaunch(account.id, where)).resolves.toEqual({ projectFolder: true, keepsProjectBackend: false });
		await expect(resolveClaudePickLaunch(other.id, where)).resolves.toEqual({ projectFolder: false, keepsProjectBackend: false });
		await expect(resolveClaudePickLaunch(account.id, { ...where, resume: true, sessionId: "elsewhere" })).resolves.toMatchObject({ projectFolder: false });
		await expect(resolveClaudePickLaunch(account.id, { ...where, resume: true, sessionId: "s-4" })).resolves.toMatchObject({ projectFolder: true });
	});
});
