import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addClaudeApiProfile,
	claudeAccountDir,
	completeClaudeLogin,
	completeCodexLogin,
	getActiveClaudeConfigDir,
	getActiveClaudeSessionEnv,
	getClaudeApiProfileDraft,
	importCurrentClaudeAccount,
	importCurrentCodexAccount,
	listAgentAccounts,
	prepareClaudeLogin,
	prepareCodexLogin,
	removeAgentAccount,
	renameAgentAccount,
	setActiveClaudeAccount,
	setActiveCodexAccount,
	updateClaudeApiProfile,
	type AccountPaths,
} from "../agent-accounts";
import { claudeApiProfileEnvKeys, ENV_UNSET } from "../../shared/agent-accounts";

let root: string;
let paths: AccountPaths;

function makeJwt(payload: Record<string, unknown>): string {
	const b64url = (obj: unknown) =>
		Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${b64url({ alg: "RS256" })}.${b64url(payload)}.sig`;
}

function seedClaudeLogin(email = "main@example.com", accountUuid = "claude-acc-1") {
	mkdirSync(paths.claudeHome, { recursive: true });
	writeFileSync(
		paths.claudeJson,
		JSON.stringify({
			hasCompletedOnboarding: true,
			oauthAccount: { emailAddress: email, organizationName: "Org", userRateLimitTier: "default_claude_max_5x", accountUuid },
			projects: {},
		}),
	);
	writeFileSync(join(paths.claudeHome, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `token-${accountUuid}` } }));
	writeFileSync(join(paths.claudeHome, "settings.json"), "{}");
}

function codexAuth(accountId: string, email = `${accountId}@example.com`, extra: Record<string, unknown> = {}) {
	return JSON.stringify({
		auth_mode: "ChatGPT",
		tokens: {
			id_token: makeJwt({ email, "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: accountId } }),
			access_token: "at",
			refresh_token: "rt",
			account_id: accountId,
		},
		last_refresh: "2026-07-01T00:00:00Z",
		...extra,
	});
}

function seedCodexLogin(accountId: string) {
	mkdirSync(paths.codexHome, { recursive: true });
	writeFileSync(join(paths.codexHome, "auth.json"), codexAuth(accountId));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-agent-accounts-"));
	paths = {
		accountsDir: join(root, "agent-accounts"),
		claudeHome: join(root, ".claude"),
		claudeJson: join(root, ".claude.json"),
		codexHome: join(root, ".codex"),
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("importCurrentClaudeAccount", () => {
	it("snapshots the current login into a managed config dir", async () => {
		seedClaudeLogin();
		const account = await importCurrentClaudeAccount(paths);

		expect(account.label).toBe("main@example.com");
		expect(account.identity?.planLabel).toBe("Max 5x");

		const dir = claudeAccountDir(account.id, paths);
		expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8")).oauthAccount.emailAddress).toBe("main@example.com");
		expect(existsSync(join(dir, ".credentials.json"))).toBe(true);
		// Shared entries are symlinked into ~/.claude, not copied.
		expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true);
	});

	it("does not auto-activate the imported account (system login stays active)", async () => {
		seedClaudeLogin();
		await importCurrentClaudeAccount(paths);
		const state = await listAgentAccounts(paths);
		expect(state.claude.activeId).toBeNull();
		expect(state.claude.systemIdentity?.email).toBe("main@example.com");
	});

	it("rejects a duplicate of an already-imported account", async () => {
		seedClaudeLogin();
		await importCurrentClaudeAccount(paths);
		await expect(importCurrentClaudeAccount(paths)).rejects.toThrow(/already added/);
	});

	it("fails cleanly when there is no login", async () => {
		await expect(importCurrentClaudeAccount(paths)).rejects.toThrow(/No Claude Code login/);
	});

	it("fails and cleans up when credentials cannot be found", async () => {
		seedClaudeLogin();
		rmSync(join(paths.claudeHome, ".credentials.json"));
		if (process.platform === "darwin") return; // Keychain fallback may exist on macOS dev machines
		await expect(importCurrentClaudeAccount(paths)).rejects.toThrow(/credentials/);
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts).toHaveLength(0);
	});
});

describe("claude login flow", () => {
	it("prepare seeds a config dir without identity and returns the login command", async () => {
		seedClaudeLogin();
		const { accountId, loginCommand } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		expect(loginCommand).toContain("CLAUDE_CONFIG_DIR=");
		expect(loginCommand).toContain(dir);
		expect(loginCommand).toContain("claude /login");
		const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8"));
		expect(seeded.oauthAccount).toBeUndefined();
		expect(seeded.hasCompletedOnboarding).toBe(true);
	});

	it("complete fails before the login happened", async () => {
		seedClaudeLogin();
		const { accountId } = await prepareClaudeLogin(paths);
		await expect(completeClaudeLogin(accountId, paths)).rejects.toThrow(/Login not detected/);
	});

	it("complete registers the account once identity + credentials exist", async () => {
		seedClaudeLogin();
		const { accountId } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		writeFileSync(
			join(dir, ".claude.json"),
			JSON.stringify({ oauthAccount: { emailAddress: "second@example.com", accountUuid: "claude-acc-2" } }),
		);
		writeFileSync(join(dir, ".credentials.json"), "{}");

		const account = await completeClaudeLogin(accountId, paths);
		expect(account.label).toBe("second@example.com");
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts.map((a) => a.id)).toContain(accountId);
	});

	it("complete rejects a login that duplicates an existing account", async () => {
		seedClaudeLogin();
		await importCurrentClaudeAccount(paths);
		const { accountId } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		writeFileSync(
			join(dir, ".claude.json"),
			JSON.stringify({
				oauthAccount: { emailAddress: "main@example.com", organizationName: "Org", accountUuid: "claude-acc-1" },
			}),
		);
		writeFileSync(join(dir, ".credentials.json"), "{}");
		await expect(completeClaudeLogin(accountId, paths)).rejects.toThrow(/already added/);
	});

	it("allows the same login in a different organization and disambiguates the label", async () => {
		// One Claude user can belong to several orgs: same email + accountUuid,
		// different organizationName. That is NOT a duplicate.
		seedClaudeLogin();
		await importCurrentClaudeAccount(paths);
		const { accountId } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		writeFileSync(
			join(dir, ".claude.json"),
			JSON.stringify({
				oauthAccount: { emailAddress: "main@example.com", organizationName: "Org B", accountUuid: "claude-acc-1" },
			}),
		);
		writeFileSync(join(dir, ".credentials.json"), "{}");

		const account = await completeClaudeLogin(accountId, paths);
		expect(account.label).toBe("main@example.com (Org B)");
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts).toHaveLength(2);
	});
});

describe("setActiveClaudeAccount / getActiveClaudeConfigDir", () => {
	it("activation controls the injected CLAUDE_CONFIG_DIR", async () => {
		seedClaudeLogin();
		const account = await importCurrentClaudeAccount(paths);

		expect(await getActiveClaudeConfigDir(paths)).toBeNull();

		await setActiveClaudeAccount(account.id, paths);
		expect(await getActiveClaudeConfigDir(paths)).toBe(claudeAccountDir(account.id, paths));

		await setActiveClaudeAccount(null, paths);
		expect(await getActiveClaudeConfigDir(paths)).toBeNull();
	});

	it("rejects unknown account ids", async () => {
		await expect(setActiveClaudeAccount("nope", paths)).rejects.toThrow(/Unknown Claude account/);
	});
});

describe("codex accounts", () => {
	it("import snapshots auth.json and becomes the active account", async () => {
		seedCodexLogin("acc-1");
		const account = await importCurrentCodexAccount(paths);
		expect(account.label).toBe("acc-1@example.com");
		expect(account.identity?.planLabel).toBe("Plus");

		const state = await listAgentAccounts(paths);
		expect(state.codex.activeId).toBe(account.id);
		expect(state.codex.currentIdentity?.accountId).toBe("acc-1");
	});

	it("rejects import without a ChatGPT login", async () => {
		await expect(importCurrentCodexAccount(paths)).rejects.toThrow(/No Codex login/);
	});

	it("switching accounts swaps auth.json and syncs refreshed tokens back", async () => {
		seedCodexLogin("acc-1");
		const first = await importCurrentCodexAccount(paths);

		// User logs into a second account (auth.json overwritten by codex login).
		writeFileSync(join(paths.codexHome, "auth.json"), codexAuth("acc-2"));
		const second = await completeCodexLogin(paths);
		expect(second.id).not.toBe(first.id);

		let state = await listAgentAccounts(paths);
		expect(state.codex.activeId).toBe(second.id);

		// Simulate codex refreshing acc-2's tokens in place.
		writeFileSync(join(paths.codexHome, "auth.json"), codexAuth("acc-2", "acc-2@example.com", { last_refresh: "2026-07-05T12:00:00Z" }));

		await setActiveCodexAccount(first.id, paths);
		const live = JSON.parse(readFileSync(join(paths.codexHome, "auth.json"), "utf-8"));
		expect(live.tokens.account_id).toBe("acc-1");

		// The outgoing account's snapshot picked up the refreshed tokens.
		const snap = JSON.parse(readFileSync(join(paths.accountsDir, "codex", second.id, "auth.json"), "utf-8"));
		expect(snap.last_refresh).toBe("2026-07-05T12:00:00Z");

		state = await listAgentAccounts(paths);
		expect(state.codex.activeId).toBe(first.id);
	});

	it("re-login into a known account refreshes its snapshot instead of duplicating", async () => {
		seedCodexLogin("acc-1");
		const first = await importCurrentCodexAccount(paths);

		writeFileSync(join(paths.codexHome, "auth.json"), codexAuth("acc-1", "acc-1@example.com", { last_refresh: "2026-07-05T09:00:00Z" }));
		const again = await completeCodexLogin(paths);
		expect(again.id).toBe(first.id);

		const state = await listAgentAccounts(paths);
		expect(state.codex.accounts).toHaveLength(1);
	});

	it("prepareCodexLogin auto-imports an unmanaged current login", async () => {
		seedCodexLogin("acc-1");
		const { loginCommand } = await prepareCodexLogin(paths);
		expect(loginCommand).toBe("codex login");
		const state = await listAgentAccounts(paths);
		expect(state.codex.accounts).toHaveLength(1);
	});

	it("reconciles activeId from whatever auth.json actually holds", async () => {
		seedCodexLogin("acc-1");
		const first = await importCurrentCodexAccount(paths);

		// User switches accounts outside dev3.
		writeFileSync(join(paths.codexHome, "auth.json"), codexAuth("acc-external"));
		const state = await listAgentAccounts(paths);
		expect(state.codex.activeId).toBeNull();
		expect(state.codex.currentIdentity?.accountId).toBe("acc-external");
		expect(state.codex.accounts.map((a) => a.id)).toContain(first.id);
	});
});

describe("claude API profiles", () => {
	it("creates a profile with its own config dir and 0600 api-profile.json", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile(
			{ baseUrl: "https://openrouter.ai/api", apiKey: "sk-or-key-1234567890abcdef", model: "claude-sonnet-4-6" },
			paths,
		);

		expect(account.auth).toBe("api");
		expect(account.label).toBe("openrouter.ai");
		expect(account.api).toEqual({
			baseUrl: "https://openrouter.ai/api",
			model: "claude-sonnet-4-6",
			slotModels: {},
			hasApiKey: true,
			envKeys: [],
		});
		expect(account.identity).toBeNull();

		const dir = claudeAccountDir(account.id, paths);
		expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(dir, "api-profile.json")).mode & 0o777).toBe(0o600);
		// Seeded .claude.json has no identity but pre-approves the API key tail.
		const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8"));
		expect(seeded.oauthAccount).toBeUndefined();
		expect(seeded.customApiKeyResponses.approved).toContain("sk-or-key-1234567890abcdef".slice(-20));
	});

	it("rejects an empty profile and a malformed base URL", async () => {
		await expect(addClaudeApiProfile({}, paths)).rejects.toThrow(/API key, a base URL, or environment/);
		await expect(addClaudeApiProfile({ baseUrl: "not a url", apiKey: "k" }, paths)).rejects.toThrow(/Invalid base URL/);
	});

	it("active API profile injects ANTHROPIC_* and extra env; master model fans out to alias slots", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile(
			{
				baseUrl: "https://openrouter.ai/api",
				apiKey: "sk-or-key",
				model: "claude-sonnet-4-6",
				env: { CLAUDE_CODE_USE_BEDROCK: "1" },
			},
			paths,
		);
		await setActiveClaudeAccount(account.id, paths);

		const env = await getActiveClaudeSessionEnv(paths);
		expect(env.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir(account.id, paths));
		expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
		expect(env.ANTHROPIC_API_KEY).toBe("sk-or-key");
		expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		// Master model → every alias slot; ANTHROPIC_MODEL is actively unset.
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-sonnet-4-6");
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-6");
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-4-6");
		expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-sonnet-4-6");
		expect(env.ANTHROPIC_MODEL).toBe(ENV_UNSET);
	});

	it("per-slot overrides emit ANTHROPIC_DEFAULT_<slot>_MODEL with name/description", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile(
			{
				apiKey: "sk-or-key",
				slotModels: {
					haiku: { id: "provider/fast", name: "Fast", description: "Cheap background model" },
					opus: { id: "provider/smart" },
				},
			},
			paths,
		);
		await setActiveClaudeAccount(account.id, paths);

		const env = await getActiveClaudeSessionEnv(paths);
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("provider/fast");
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME).toBe("Fast");
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION).toBe("Cheap background model");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("provider/smart");
		// Untouched slots are actively unset.
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(ENV_UNSET);
	});

	it("active OAuth account injects CLAUDE_CONFIG_DIR and unsets every API-profile var; empty registry injects nothing", async () => {
		seedClaudeLogin();
		expect(await getActiveClaudeSessionEnv(paths)).toEqual({});

		const account = await importCurrentClaudeAccount(paths);
		await setActiveClaudeAccount(account.id, paths);
		const env = await getActiveClaudeSessionEnv(paths);
		expect(env.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir(account.id, paths));
		for (const key of claudeApiProfileEnvKeys()) {
			if (key === "CLAUDE_CONFIG_DIR") continue;
			expect(env[key]).toBe(ENV_UNSET);
		}
	});

	it("system login (no active account) unsets API-profile vars incl. CLAUDE_CONFIG_DIR when accounts exist", async () => {
		seedClaudeLogin();
		await importCurrentClaudeAccount(paths);
		// activeId stays null → system login, but a stale profile env must still be cleared.
		const env = await getActiveClaudeSessionEnv(paths);
		for (const key of claudeApiProfileEnvKeys()) {
			expect(env[key]).toBe(ENV_UNSET);
		}
	});

	it("switching to OAuth unsets extra env vars carried by an inactive API profile", async () => {
		seedClaudeLogin();
		await addClaudeApiProfile({ apiKey: "sk-x", env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, paths);
		const oauth = await importCurrentClaudeAccount(paths);
		await setActiveClaudeAccount(oauth.id, paths);
		const env = await getActiveClaudeSessionEnv(paths);
		expect(env.CLAUDE_CODE_USE_BEDROCK).toBe(ENV_UNSET);
		expect(env.ANTHROPIC_API_KEY).toBe(ENV_UNSET);
	});

	it("remove deletes the profile dir together with its key", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile({ apiKey: "sk-x" }, paths);
		expect(account.label).toBe("API profile 1");
		await removeAgentAccount("claude", account.id, paths);
		expect(existsSync(claudeAccountDir(account.id, paths))).toBe(false);
		expect(await getActiveClaudeSessionEnv(paths)).toEqual({});
	});

	it("draft returns the editable fields including the key value and slot overrides", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile(
			{
				label: "OR",
				baseUrl: "https://openrouter.ai/api",
				apiKey: "sk-secret-value",
				slotModels: { haiku: { id: "provider/fast", name: "Fast" } },
				env: { AWS_REGION: "us-east-1" },
			},
			paths,
		);
		const draft = await getClaudeApiProfileDraft(account.id, paths);
		expect(draft).toEqual({
			label: "OR",
			baseUrl: "https://openrouter.ai/api",
			apiKey: "sk-secret-value",
			model: "",
			slotModels: { haiku: { id: "provider/fast", name: "Fast" } },
			envText: "AWS_REGION=us-east-1",
			hasApiKey: true,
		});
	});

	it("update rewrites fields and keeps the stored key when apiKey is omitted", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile(
			{ baseUrl: "https://openrouter.ai/api", apiKey: "sk-original", model: "old-model", env: { A: "1" } },
			paths,
		);
		const updated = await updateClaudeApiProfile(
			account.id,
			{ label: "Renamed", baseUrl: "https://api.anthropic.com", model: "new-model", env: { B: "2" } },
			paths,
		);
		expect(updated.label).toBe("Renamed");
		expect(updated.api).toEqual({
			baseUrl: "https://api.anthropic.com",
			model: "new-model",
			slotModels: {},
			hasApiKey: true,
			envKeys: ["B"],
		});
		// Key preserved on disk (apiKey omitted → keep); master model fans out to slots.
		await setActiveClaudeAccount(account.id, paths);
		const env = await getActiveClaudeSessionEnv(paths);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-original");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("new-model");
		expect(env.ANTHROPIC_MODEL).toBe(ENV_UNSET);
		expect(env.A).toBeUndefined();
		expect(env.B).toBe("2");
	});

	it("update swaps master override for per-slot overrides", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile({ apiKey: "sk-x", model: "master-model" }, paths);
		await updateClaudeApiProfile(account.id, { model: "", slotModels: { sonnet: { id: "provider/sonnet" } } }, paths);
		await setActiveClaudeAccount(account.id, paths);
		const env = await getActiveClaudeSessionEnv(paths);
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("provider/sonnet");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(ENV_UNSET);
	});

	it("update replaces the key and re-approves its tail when a new key is given", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile({ apiKey: "sk-original-key" }, paths);
		await updateClaudeApiProfile(account.id, { apiKey: "sk-brand-new-key-1234567890" }, paths);
		await setActiveClaudeAccount(account.id, paths);
		expect((await getActiveClaudeSessionEnv(paths)).ANTHROPIC_API_KEY).toBe("sk-brand-new-key-1234567890");
		const seeded = JSON.parse(readFileSync(join(claudeAccountDir(account.id, paths), ".claude.json"), "utf-8"));
		expect(seeded.customApiKeyResponses.approved).toContain("sk-brand-new-key-1234567890".slice(-20));
	});

	it("update rejects a profile left with nothing and a malformed base URL", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile({ apiKey: "sk-x" }, paths);
		await expect(updateClaudeApiProfile(account.id, { apiKey: "", env: {} }, paths)).rejects.toThrow(
			/API key, a base URL, or environment/,
		);
		await expect(updateClaudeApiProfile(account.id, { baseUrl: "not a url" }, paths)).rejects.toThrow(/Invalid base URL/);
	});

	it("draft and update reject a non-API (oauth) account", async () => {
		seedClaudeLogin();
		const oauth = await importCurrentClaudeAccount(paths);
		await expect(getClaudeApiProfileDraft(oauth.id, paths)).rejects.toThrow(/Only API profiles/);
		await expect(updateClaudeApiProfile(oauth.id, { model: "x" }, paths)).rejects.toThrow(/Only API profiles/);
	});
});

describe("remove / rename", () => {
	it("remove deletes the stored dir and clears active", async () => {
		seedClaudeLogin();
		const account = await importCurrentClaudeAccount(paths);
		await setActiveClaudeAccount(account.id, paths);

		await removeAgentAccount("claude", account.id, paths);
		expect(existsSync(claudeAccountDir(account.id, paths))).toBe(false);
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts).toHaveLength(0);
		expect(state.claude.activeId).toBeNull();
	});

	it("remove of an unregistered (pending) claude dir is a silent cleanup", async () => {
		seedClaudeLogin();
		const { accountId } = await prepareClaudeLogin(paths);
		await removeAgentAccount("claude", accountId, paths);
		expect(existsSync(claudeAccountDir(accountId, paths))).toBe(false);
	});

	it("rename updates the label", async () => {
		seedClaudeLogin();
		const account = await importCurrentClaudeAccount(paths);
		await renameAgentAccount("claude", account.id, "Work", paths);
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts[0].label).toBe("Work");
	});

	it("rename rejects empty labels and unknown ids", async () => {
		seedClaudeLogin();
		const account = await importCurrentClaudeAccount(paths);
		await expect(renameAgentAccount("claude", account.id, "  ", paths)).rejects.toThrow(/empty/);
		await expect(renameAgentAccount("claude", "nope", "X", paths)).rejects.toThrow(/Unknown/);
	});
});

describe("listAgentAccounts", () => {
	it("returns an empty state when nothing exists", async () => {
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts).toHaveLength(0);
		expect(state.claude.activeId).toBeNull();
		expect(state.claude.systemIdentity).toBeNull();
		expect(state.codex.accounts).toHaveLength(0);
		expect(state.codex.activeId).toBeNull();
		expect(state.codex.currentIdentity).toBeNull();
	});

	it("survives a corrupt registry file", async () => {
		mkdirSync(paths.accountsDir, { recursive: true });
		writeFileSync(join(paths.accountsDir, "accounts.json"), "{corrupt");
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts).toHaveLength(0);
	});
});
