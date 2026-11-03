import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeAccountDir,
	getActiveClaudeConfigDir,
	getActiveClaudeSessionEnv,
	importCurrentClaudeAccount,
	listAgentAccounts,
	prepareClaudeLogin,
	refreshStagedLogin,
	registerStagedClaudeAccount,
	removeAgentAccount,
	renameAgentAccount,
	setActiveClaudeAccount,
	STAGED_LOGIN_MARKER,
	sweepAbandonedStagedLogins,
	discardStagedLogin,
	type AccountPaths,
} from "../agent-accounts";
import { DEV3_AGENT_ACCOUNT_ID_ENV, ENV_UNSET } from "../../shared/agent-accounts";

let root: string;
let paths: AccountPaths;

function makeDir(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** A managed account created the way the app does, from a fake system login. */
async function managedAccount() {
	mkdirSync(paths.claudeHome, { recursive: true });
	writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: "main@example.com", accountUuid: "u1" } }));
	writeFileSync(join(paths.claudeHome, ".credentials.json"), "{}");
	return importCurrentClaudeAccount(paths);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-agent-accounts-sel-"));
	paths = {
		accountsDir: join(root, "agent-accounts"),
		claudeHome: join(root, ".claude"),
		claudeJson: join(root, ".claude.json"),
		codexHome: join(root, ".codex"),
	};
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Claude account selection never falls back silently", () => {
	it("throws for an explicit unknown account, also with an empty registry", async () => {
		await expect(getActiveClaudeSessionEnv("nope", paths)).rejects.toThrow("Unknown Claude account: nope");
		await expect(getActiveClaudeConfigDir("nope", paths)).rejects.toThrow("Unknown Claude account: nope");
		await managedAccount();
		await expect(getActiveClaudeSessionEnv("nope", paths)).rejects.toThrow("Unknown Claude account: nope");
	});

	it("null forces the system login with no CLAUDE_CONFIG_DIR; no default stays system", async () => {
		const account = await managedAccount();
		await setActiveClaudeAccount(account.id, paths);
		const env = await getActiveClaudeSessionEnv(null, paths);
		expect(env.CLAUDE_CONFIG_DIR).toBe(ENV_UNSET);
		expect(env[DEV3_AGENT_ACCOUNT_ID_ENV]).toBe(ENV_UNSET);
		await setActiveClaudeAccount(null, paths);
		expect((await getActiveClaudeSessionEnv(undefined, paths)).CLAUDE_CONFIG_DIR).toBe(ENV_UNSET);
		expect(await getActiveClaudeConfigDir(undefined, paths)).toBeNull();
	});

	it("throws when the selected managed account has no .claude.json, for an explicit id and for the default", async () => {
		const account = await managedAccount();
		rmSync(join(claudeAccountDir(account.id, paths), ".claude.json"));
		await expect(getActiveClaudeSessionEnv(account.id, paths)).rejects.toThrow(/not signed in/);
		await expect(getActiveClaudeConfigDir(account.id, paths)).rejects.toThrow(/not signed in/);
		await setActiveClaudeAccount(account.id, paths);
		await expect(getActiveClaudeSessionEnv(undefined, paths)).rejects.toThrow(/not signed in/);
	});

	it("throws when the selected managed config dir is gone", async () => {
		const account = await managedAccount();
		rmSync(claudeAccountDir(account.id, paths), { recursive: true });
		await expect(getActiveClaudeSessionEnv(account.id, paths)).rejects.toThrow(/config folder not found/);
	});
});

/** A staged sign-in as the app creates it: a seeded dir with no identity and the abandoned-login marker. */
async function stagedLogin() {
	mkdirSync(paths.claudeHome, { recursive: true });
	writeFileSync(paths.claudeJson, JSON.stringify({ hasCompletedOnboarding: true }));
	return prepareClaudeLogin(paths);
}

describe("registerStagedClaudeAccount (add without signing in)", () => {
	it("registers the staged dir with no identity, keeps the default and unmarks it", async () => {
		const { accountId, loginCommand } = await stagedLogin();
		const dir = claudeAccountDir(accountId, paths);
		expect(existsSync(join(dir, STAGED_LOGIN_MARKER))).toBe(true);
		expect(loginCommand).toBe(`CLAUDE_CONFIG_DIR='${dir}' claude /login`);

		const account = registerStagedClaudeAccount(accountId, paths);
		expect(account).toMatchObject({ id: accountId, label: "Account 1", identity: null, auth: "oauth" });
		expect(existsSync(join(dir, STAGED_LOGIN_MARKER))).toBe(false);
		const registry = JSON.parse(readFileSync(join(paths.accountsDir, "accounts.json"), "utf-8"));
		expect(registry.claude.accounts.map((a: { id: string }) => a.id)).toEqual([accountId]);
		expect(registry.claude.activeId).toBeNull();
		// The sweep that cleans abandoned sign-ins must leave it alone, even long after.
		expect(sweepAbandonedStagedLogins("claude", 1, Date.now() + 10 * 24 * 3_600_000, paths)).toBe(0);
		expect(existsSync(dir)).toBe(true);
	});

	it("shows the identity by itself once a login writes it, and launches without further steps", async () => {
		const { accountId } = await stagedLogin();
		registerStagedClaudeAccount(accountId, paths);
		const dir = claudeAccountDir(accountId, paths);
		expect((await getActiveClaudeSessionEnv(accountId, paths)).CLAUDE_CONFIG_DIR).toBe(dir);

		writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "later@example.com", accountUuid: "late-1" } }));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
		const listed = (await listAgentAccounts(paths)).claude.accounts[0];
		vi.unstubAllGlobals();
		expect(listed.identity?.email).toBe("later@example.com");
	});

	it("swaps the placeholder label for the email once it appears, then leaves the label alone", async () => {
		const { accountId } = await stagedLogin();
		registerStagedClaudeAccount(accountId, paths);
		const dir = claudeAccountDir(accountId, paths);
		expect((await listAgentAccounts(paths)).claude.accounts[0].label).toBe("Account 1");

		writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "later@example.com", accountUuid: "late-1" } }));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
		expect((await listAgentAccounts(paths)).claude.accounts[0].label).toBe("later@example.com");
		const saved = JSON.parse(readFileSync(join(paths.accountsDir, "accounts.json"), "utf-8"));
		expect(saved.claude.accounts[0].autoLabel).toBeUndefined();

		await renameAgentAccount("claude", accountId, "Mine", paths);
		writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "other@example.com", accountUuid: "late-2" } }));
		expect((await listAgentAccounts(paths)).claude.accounts[0].label).toBe("Mine");
		vi.unstubAllGlobals();
	});

	it("a manual rename before the login keeps the name", async () => {
		const { accountId } = await stagedLogin();
		registerStagedClaudeAccount(accountId, paths);
		await renameAgentAccount("claude", accountId, "Wrapper", paths);
		writeFileSync(join(claudeAccountDir(accountId, paths), ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "later@example.com", accountUuid: "late-1" } }));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
		const listed = (await listAgentAccounts(paths)).claude.accounts[0];
		vi.unstubAllGlobals();
		expect(listed).toMatchObject({ label: "Wrapper", identity: { email: "later@example.com" } });
	});

	it("never renames an ordinary account", async () => {
		const account = await managedAccount();
		await renameAgentAccount("claude", account.id, "Work", paths);
		expect((await listAgentAccounts(paths)).claude.accounts[0].label).toBe("Work");
		const saved = JSON.parse(readFileSync(join(paths.accountsDir, "accounts.json"), "utf-8"));
		expect(saved.claude.accounts[0]).not.toHaveProperty("autoLabel");
	});

	it("does no duplicate check: two unsigned accounts can coexist", async () => {
		const first = await stagedLogin();
		const second = await stagedLogin();
		registerStagedClaudeAccount(first.accountId, paths);
		registerStagedClaudeAccount(second.accountId, paths);
		expect((await listAgentAccounts(paths)).claude.accounts.map((a) => a.label)).toEqual(["Account 1", "Account 2"]);
	});

	it("returns the account when the id is already registered", async () => {
		const { accountId } = await stagedLogin();
		const account = registerStagedClaudeAccount(accountId, paths);
		expect(registerStagedClaudeAccount(accountId, paths).id).toBe(account.id);
		expect(JSON.parse(readFileSync(join(paths.accountsDir, "accounts.json"), "utf-8")).claude.accounts).toHaveLength(1);
	});

	it("refuses a dir that is gone", async () => {
		expect(() => registerStagedClaudeAccount("11111111-2222-3333-4444-555555555555", paths)).toThrow(/already ended/);
	});
});

describe("refreshStagedLogin", () => {
	it("restarts the abandoned clock, so another instance's sweep keeps a login that was just started", async () => {
		const { accountId } = await stagedLogin();
		const dir = claudeAccountDir(accountId, paths);
		writeFileSync(join(dir, STAGED_LOGIN_MARKER), JSON.stringify({ createdAt: 1 }));
		const later = 25 * 60_000;
		refreshStagedLogin("claude", accountId, paths);
		expect(sweepAbandonedStagedLogins("claude", 20 * 60_000, Date.now() + later - 10 * 60_000, paths)).toBe(0);
		expect(existsSync(dir)).toBe(true);
	});

	it("leaves an unmarked (registered) dir alone", async () => {
		const { accountId } = await stagedLogin();
		registerStagedClaudeAccount(accountId, paths);
		refreshStagedLogin("claude", accountId, paths);
		expect(existsSync(join(claudeAccountDir(accountId, paths), STAGED_LOGIN_MARKER))).toBe(false);
	});
});

describe("a slot the user's own tool replaced with a link to its folder", () => {
	/** A managed account whose dir was then swapped for a link, as a wrapper might do. */
	async function linkedAccount(target: string) {
		const { accountId } = await stagedLogin();
		registerStagedClaudeAccount(accountId, paths);
		const slot = claudeAccountDir(accountId, paths);
		rmSync(slot, { recursive: true });
		symlinkSync(target, slot, "dir");
		return { id: accountId, slot };
	}

	it("launches with the slot path, even when the target is empty, and never fills the target", async () => {
		mkdirSync(paths.claudeHome, { recursive: true });
		writeFileSync(join(paths.claudeHome, "settings.json"), "{}");
		const target = makeDir("their folder");
		const { id, slot } = await linkedAccount(target);
		expect((await getActiveClaudeSessionEnv(id, paths)).CLAUDE_CONFIG_DIR).toBe(slot);
		expect(await getActiveClaudeConfigDir(id, paths)).toBe(slot);
		expect(await getActiveClaudeConfigDir(id, paths)).toBe(slot);
		expect(readdirSync(target)).toEqual([]);
	});

	it("throws when the link dangles", async () => {
		const target = makeDir("soon-gone");
		const { id } = await linkedAccount(target);
		rmSync(target, { recursive: true });
		await expect(getActiveClaudeSessionEnv(id, paths)).rejects.toThrow(/config folder not found/);
		await expect(getActiveClaudeConfigDir(id, paths)).rejects.toThrow(/config folder not found/);
	});

	it("removal unlinks the slot and leaves every file of the target alone", async () => {
		const target = makeDir("keep-me");
		mkdirSync(join(target, "projects"));
		writeFileSync(join(target, "history.jsonl"), "precious");
		writeFileSync(join(target, "projects", "t.jsonl"), "transcript");
		const { id, slot } = await linkedAccount(target);
		await setActiveClaudeAccount(id, paths);
		await removeAgentAccount("claude", id, paths);
		expect((await listAgentAccounts(paths)).claude.accounts).toHaveLength(0);
		expect(existsSync(slot)).toBe(false);
		expect(readFileSync(join(target, "history.jsonl"), "utf-8")).toBe("precious");
		expect(readFileSync(join(target, "projects", "t.jsonl"), "utf-8")).toBe("transcript");
	});

	it("staged-login discard and sweep never delete through a link", async () => {
		const dir = makeDir("sweep-target");
		writeFileSync(join(dir, STAGED_LOGIN_MARKER), JSON.stringify({ createdAt: 1 }));
		writeFileSync(join(dir, "keep.txt"), "keep");
		mkdirSync(join(paths.accountsDir, "claude"), { recursive: true });
		symlinkSync(dir, join(paths.accountsDir, "claude", "orphan-link"), "dir");
		expect(sweepAbandonedStagedLogins("claude", 10, Date.now(), paths)).toBe(1);
		expect(readFileSync(join(dir, "keep.txt"), "utf-8")).toBe("keep");
		symlinkSync(dir, join(paths.accountsDir, "claude", "orphan-link-2"), "dir");
		expect(discardStagedLogin("claude", "orphan-link-2", paths)).toBe(true);
		expect(readFileSync(join(dir, "keep.txt"), "utf-8")).toBe("keep");
	});

	it("removes a real slot normally when its parent folder is a link", async () => {
		const outside = makeDir("outside-claude");
		mkdirSync(join(outside, "some-id"));
		writeFileSync(join(outside, "some-id", "file.txt"), "x");
		mkdirSync(paths.accountsDir, { recursive: true });
		symlinkSync(outside, join(paths.accountsDir, "claude"), "dir");
		expect(discardStagedLogin("claude", "some-id", paths)).toBe(true);
		expect(existsSync(join(outside, "some-id"))).toBe(false);
	});
});
