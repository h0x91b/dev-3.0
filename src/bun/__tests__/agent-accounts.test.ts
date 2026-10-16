import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addClaudeApiProfile,
	claudeAccountDir,
	isPrivateClaudeEntry,
	codexAccountDir,
	codexAccountIdForHome,
	completeClaudeLogin,
	completeCodexLogin,
	discardStagedLogin,
	STAGED_LOGIN_MARKER,
	sweepAbandonedStagedLogins,
	completeOmpLogin,
	getActiveClaudeConfigDir,
	getActiveClaudeSessionEnv,
	getActiveCodexSessionEnv,
	getActiveOmpSessionEnv,
	getClaudeApiProfileDraft,
	importCurrentClaudeAccount,
	importCurrentCodexAccount,
	isPrivateOmpEntry,
	listAgentAccounts,
	ompAccountDir,
	prepareClaudeLogin,
	prepareCodexLogin,
	LoginNotReadyError,
	prepareOmpLogin,
	registeredOutputStyleName,
	removeAgentAccount,
	renameAgentAccount,
	setActiveClaudeAccount,
	setActiveCodexAccount,
	stagedLoginHasIdentity,
	setActiveOmpAccount,
	updateClaudeApiProfile,
	claudeAuthStatusMismatch,
	parseClaudeAuthStatus,
	type AccountPaths,
	type ClaudeAuthStatusProbe,
} from "../agent-accounts";
import { claudeApiProfileEnvKeys, ENV_UNSET, type OmpLogin } from "../../shared/agent-accounts";

let root: string;
let paths: AccountPaths;

/** Synthetic `claude auth status`: exactly the fields the 2.1.x binary prints for a
 *  subscription login (no `apiKeySource` — it only appears with a key source). */
function confirmedStatus(email: string, over: Record<string, unknown> = {}, exitCode = 0): ClaudeAuthStatusProbe {
	return async (configDir) => ({
		exitCode,
		stdout: JSON.stringify(
			{
				loggedIn: true,
				authMethod: "claude.ai",
				apiProvider: "firstParty",
				analyticsDisabled: false,
				projectsDirectory: join(configDir, "projects"),
				configDirectory: configDir,
				email,
				orgId: "org-uuid",
				orgName: null,
				subscriptionType: "max",
				...over,
			},
			null,
			2,
		),
	});
}

const unavailableStatus: ClaudeAuthStatusProbe = async () => null;

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

function codexAuth(
	accountId: string,
	email = `${accountId}@example.com`,
	extra: Record<string, unknown> = {},
	organizations: Array<{ id: string; title: string }> = [],
) {
	return JSON.stringify({
		auth_mode: "ChatGPT",
		tokens: {
			id_token: makeJwt({
				email,
				"https://api.openai.com/auth": {
					chatgpt_plan_type: "plus",
					chatgpt_account_id: accountId,
					organizations,
				},
			}),
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

function mockCodexWorkspaceNames(workspaces: Array<{ id: string; name: string }>) {
	vi.mocked(globalThis.fetch).mockResolvedValue(
		new Response(
			JSON.stringify({
				accounts: Object.fromEntries(
					workspaces.map(({ id, name }) => [id, { account: { account_id: id, name } }]),
				),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		),
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-agent-accounts-"));
	paths = {
		accountsDir: join(root, "agent-accounts"),
		claudeHome: join(root, ".claude"),
		claudeJson: join(root, ".claude.json"),
		codexHome: join(root, ".codex"),
		ompAgentHome: join(root, ".omp", "agent"),
	};
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});

describe("isPrivateClaudeEntry", () => {
	it("keeps login, identity, usage and org policy per-account", () => {
		for (const entry of [".credentials.json", ".claude.json", "stats-cache.json", "policy-limits.json", "statsig"]) {
			expect(isPrivateClaudeEntry(entry)).toBe(true);
		}
	});

	it("catches credential-shaped names dev3 has never seen", () => {
		for (const entry of ["oauth-credentials.json", "auth.json", "authProfile.json", "refresh-token", "api.key"]) {
			expect(isPrivateClaudeEntry(entry)).toBe(true);
		}
	});

	it("shares user customization and ordinary runtime state", () => {
		for (const entry of ["settings.json", "settings.local.json", "skills", "workflows", "routines", "hooks", "CLAUDE.md", "history.jsonl", "sessions", "cache"]) {
			expect(isPrivateClaudeEntry(entry)).toBe(false);
		}
	});
});

describe("registeredOutputStyleName", () => {
	// Claude Code registers a style under frontmatter `name` INSTEAD of the
	// filename slug — the slug is not kept as an alias, so a settings.json value
	// of "low-battery" never matches a file declaring `name: Low Battery`.
	it("prefers the frontmatter name over the filename slug", () => {
		const md = "---\nname: Low Battery\ndescription: x\nkeep-coding-instructions: true\n---\n\n# body\n";
		expect(registeredOutputStyleName("low-battery.md", md)).toBe("Low Battery");
	});

	it("falls back to the filename slug when there is no frontmatter name", () => {
		expect(registeredOutputStyleName("my-style.md", "---\ndescription: x\n---\nbody")).toBe("my-style");
		expect(registeredOutputStyleName("my-style.md", "# no frontmatter at all")).toBe("my-style");
	});

	it("ignores a name-like line in the body and strips quotes", () => {
		expect(registeredOutputStyleName("s.md", '---\nname: "Quoted Name"\n---\nname: Not This\n')).toBe("Quoted Name");
		expect(registeredOutputStyleName("s.md", "---\ndescription: x\n---\nname: Body Name\n")).toBe("s");
	});
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

	it("symlinks every non-private ~/.claude entry, including ones dev3 has never heard of", async () => {
		seedClaudeLogin();
		mkdirSync(join(paths.claudeHome, "output-styles"), { recursive: true });
		writeFileSync(join(paths.claudeHome, "output-styles", "custom.md"), "# custom");
		// Resource types Claude Code resolves by name that predate no allow-list entry.
		for (const dirName of ["skills", "workflows", "routines", "hooks", "some-future-thing"]) {
			mkdirSync(join(paths.claudeHome, dirName), { recursive: true });
		}
		writeFileSync(join(paths.claudeHome, "RTK.md"), "# imported via @RTK.md");
		writeFileSync(join(paths.claudeHome, ".DS_Store"), "junk");

		const account = await importCurrentClaudeAccount(paths);
		const dir = claudeAccountDir(account.id, paths);

		for (const entry of ["settings.json", "output-styles", "workflows", "routines", "hooks", "some-future-thing", "RTK.md"]) {
			expect(lstatSync(join(dir, entry)).isSymbolicLink()).toBe(true);
		}
		expect(existsSync(join(dir, "output-styles", "custom.md"))).toBe(true);
		expect(existsSync(join(dir, ".DS_Store"))).toBe(false);
	});

	it("never symlinks the entries that make an account an account", async () => {
		seedClaudeLogin();
		for (const file of ["stats-cache.json", "policy-limits.json", "oauth-token.json", "authProfile.json"]) {
			writeFileSync(join(paths.claudeHome, file), "{}");
		}
		mkdirSync(join(paths.claudeHome, "statsig"), { recursive: true });
		const account = await importCurrentClaudeAccount(paths);
		const dir = claudeAccountDir(account.id, paths);

		for (const entry of ["stats-cache.json", "policy-limits.json", "statsig", "oauth-token.json", "authProfile.json"]) {
			expect(existsSync(join(dir, entry))).toBe(false);
		}
		// The login is a real per-account copy, never a link into ~/.claude.
		expect(lstatSync(join(dir, ".credentials.json")).isSymbolicLink()).toBe(false);
	});

	it("does not auto-activate the imported account (system login stays active)", async () => {
		seedClaudeLogin();
		await importCurrentClaudeAccount(paths);
		const state = await listAgentAccounts(paths);
		expect(state.claude.activeId).toBeNull();
		expect(state.claude.systemIdentity?.email).toBe("main@example.com");
		expect(state.claude.systemConfigDir).toBe(paths.claudeHome);
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
		await expect(completeClaudeLogin(accountId, paths, unavailableStatus)).rejects.toThrow(/Login not detected/);
	});

	it("before the login lands, complete says not-ready (keep watching) rather than failing", async () => {
		seedClaudeLogin();
		const { accountId } = await prepareClaudeLogin(paths);
		const probe = vi.fn(unavailableStatus);
		await expect(completeClaudeLogin(accountId, paths, probe)).rejects.toBeInstanceOf(LoginNotReadyError);
		// No identity yet → the provider CLI is not even started.
		expect(probe).not.toHaveBeenCalled();
		expect(stagedLoginHasIdentity("claude", accountId, paths)).toBe(false);
	});

	it("prepare hands a launch scoped by env to its own dir, and pre-trusts that dir", async () => {
		seedClaudeLogin();
		const { accountId, launch } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		expect(launch).toEqual({ command: "claude", args: ["/login"], env: { CLAUDE_CONFIG_DIR: dir }, cwd: dir });
		const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8"));
		expect(seeded.projects[dir].hasTrustDialogAccepted).toBe(true);
	});

	it("sweeps only marked, unregistered staged dirs older than the TTL", async () => {
		seedClaudeLogin();
		const stale = await prepareClaudeLogin(paths);
		const fresh = await prepareClaudeLogin(paths);
		const saved = await prepareClaudeLogin(paths);
		const savedDir = claudeAccountDir(saved.accountId, paths);
		writeFileSync(join(savedDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "s@example.com", accountUuid: "claude-acc-s" } }));
		await completeClaudeLogin(saved.accountId, paths, confirmedStatus("s@example.com"));
		expect(existsSync(join(savedDir, STAGED_LOGIN_MARKER))).toBe(false);
		// A dir from an older build has no marker: never ours to judge.
		const legacy = claudeAccountDir("legacy-unmarked", paths);
		mkdirSync(legacy, { recursive: true });
		const staleDir = claudeAccountDir(stale.accountId, paths);
		writeFileSync(join(staleDir, STAGED_LOGIN_MARKER), JSON.stringify({ createdAt: Date.now() - 60 * 60_000 }));

		expect(sweepAbandonedStagedLogins("claude", 20 * 60_000, Date.now(), paths)).toBe(1);
		expect(existsSync(staleDir)).toBe(false);
		expect(existsSync(claudeAccountDir(fresh.accountId, paths))).toBe(true);
		expect(existsSync(savedDir)).toBe(true);
		expect(existsSync(legacy)).toBe(true);
	});

	it("discardStagedLogin deletes an unverified dir but refuses a saved account", async () => {
		seedClaudeLogin();
		const staged = await prepareClaudeLogin(paths);
		expect(discardStagedLogin("claude", staged.accountId, paths)).toBe(true);
		expect(existsSync(claudeAccountDir(staged.accountId, paths))).toBe(false);

		const saved = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(saved.accountId, paths);
		writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "second@example.com", accountUuid: "claude-acc-2" } }));
		writeFileSync(join(dir, ".credentials.json"), "{}");
		expect(stagedLoginHasIdentity("claude", saved.accountId, paths)).toBe(true);
		await completeClaudeLogin(saved.accountId, paths, confirmedStatus("second@example.com"));
		expect(discardStagedLogin("claude", saved.accountId, paths)).toBe(false);
		expect(existsSync(join(dir, ".credentials.json"))).toBe(true);
	});

	it("complete registers only when the provider's auth status confirms this dir and account", async () => {
		seedClaudeLogin();
		const { accountId, launch } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		writeFileSync(
			join(dir, ".claude.json"),
			JSON.stringify({ oauthAccount: { emailAddress: "second@example.com", accountUuid: "claude-acc-2" } }),
		);

		const account = await completeClaudeLogin(accountId, paths, confirmedStatus("second@example.com"));
		expect(account.label).toBe("second@example.com");
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts.map((a) => a.id)).toContain(accountId);
		// The dir a launch injects is the very dir the login ran in (Claude keys its Keychain item by it).
		await setActiveClaudeAccount(accountId, paths);
		expect(await getActiveClaudeConfigDir(undefined, paths)).toBe(launch.env.CLAUDE_CONFIG_DIR);
	});

	it("REGRESSION: a new login never gets the system login's credentials copied in", async () => {
		seedClaudeLogin();
		writeFileSync(join(paths.claudeHome, ".credentials.json"), JSON.stringify({ marker: "SYSTEM-ACCOUNT-TOKEN" }));
		const { accountId } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "new@example.com", accountUuid: "claude-acc-new" } }));

		await expect(completeClaudeLogin(accountId, paths, unavailableStatus)).rejects.toMatchObject({ reason: "status-unavailable" });
		expect(existsSync(join(dir, ".credentials.json"))).toBe(false);

		await completeClaudeLogin(accountId, paths, confirmedStatus("new@example.com"));
		expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
	});

	it("identity alone never registers: every status that does not match stays pending", async () => {
		seedClaudeLogin();
		const { accountId } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "new@example.com", accountUuid: "claude-acc-new" } }));
		const notReady = { reason: "status-mismatch" };
		const cases: ClaudeAuthStatusProbe[] = [
			confirmedStatus("new@example.com", { loggedIn: false, authMethod: "none" }, 1),
			// An env key makes Claude Code report loggedIn with no /login at all.
			confirmedStatus("new@example.com", { authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY", email: undefined }),
			confirmedStatus("new@example.com", { authMethod: "api_key_helper" }),
			confirmedStatus("new@example.com", { apiProvider: "bedrock", authMethod: "third_party" }),
			confirmedStatus("new@example.com", { configDirectory: paths.claudeHome }),
			confirmedStatus("other@example.com"),
		];
		for (const probe of cases) {
			await expect(completeClaudeLogin(accountId, paths, probe)).rejects.toMatchObject(notReady);
		}
		await expect(completeClaudeLogin(accountId, paths, async () => ({ exitCode: 0, stdout: "not json" }))).rejects.toMatchObject({ reason: "status-unavailable" });
		expect((await listAgentAccounts(paths)).claude.accounts).toHaveLength(0);
	});

	it("a Console login is accepted only with the key /login itself manages", () => {
		const status = { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "/login managed key", configDirectory: "/d", email: "c@example.com" };
		expect(claudeAuthStatusMismatch(status, 0, "/d", "c@example.com")).toBeNull();
		expect(claudeAuthStatusMismatch({ ...status, apiKeySource: "ANTHROPIC_API_KEY" }, 0, "/d", "c@example.com")).not.toBeNull();
		expect(parseClaudeAuthStatus("warning: x\n{\"loggedIn\":true}\n")).toEqual({ loggedIn: true });
	});

	it("a cancel that lands during the status probe registers nothing", async () => {
		seedClaudeLogin();
		const { accountId } = await prepareClaudeLogin(paths);
		const dir = claudeAccountDir(accountId, paths);
		writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "new@example.com", accountUuid: "claude-acc-new" } }));
		await expect(
			completeClaudeLogin(accountId, paths, confirmedStatus("new@example.com"), { stillWanted: () => false }),
		).rejects.toThrow(/closed/);
		expect((await listAgentAccounts(paths)).claude.accounts).toHaveLength(0);
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
		await expect(completeClaudeLogin(accountId, paths, confirmedStatus("main@example.com"))).rejects.toThrow(/already added/);
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

		const account = await completeClaudeLogin(accountId, paths, confirmedStatus("main@example.com"));
		expect(account.label).toBe("main@example.com (Org B)");
		const state = await listAgentAccounts(paths);
		expect(state.claude.accounts).toHaveLength(2);
	});
});

describe("setActiveClaudeAccount / getActiveClaudeConfigDir", () => {
	it("activation controls the injected CLAUDE_CONFIG_DIR", async () => {
		seedClaudeLogin();
		const account = await importCurrentClaudeAccount(paths);

		expect(await getActiveClaudeConfigDir(undefined, paths)).toBeNull();

		await setActiveClaudeAccount(account.id, paths);
		expect(await getActiveClaudeConfigDir(undefined, paths)).toBe(claudeAccountDir(account.id, paths));

		await setActiveClaudeAccount(null, paths);
		expect(await getActiveClaudeConfigDir(undefined, paths)).toBeNull();
	});

	it("rejects unknown account ids", async () => {
		await expect(setActiveClaudeAccount("nope", paths)).rejects.toThrow(/Unknown Claude account/);
	});

	it("backfills a shared entry missing from an account created by an older version", async () => {
		seedClaudeLogin();
		mkdirSync(join(paths.claudeHome, "output-styles"), { recursive: true });
		const account = await importCurrentClaudeAccount(paths);
		const dir = claudeAccountDir(account.id, paths);
		unlinkSync(join(dir, "output-styles")); // simulate the pre-fix on-disk state

		expect(await getActiveClaudeConfigDir(account.id, paths)).toBe(dir);
		expect(lstatSync(join(dir, "output-styles")).isSymbolicLink()).toBe(true);
	});

	it("per-launch accountId override selects an account regardless of the registry default", async () => {
		seedClaudeLogin();
		const account = await importCurrentClaudeAccount(paths);
		// Registry default stays the system login (activeId=null)…
		await setActiveClaudeAccount(null, paths);
		expect(await getActiveClaudeConfigDir(undefined, paths)).toBeNull();
		// …but an explicit per-launch override picks the managed account for THIS launch.
		expect(await getActiveClaudeConfigDir(account.id, paths)).toBe(claudeAccountDir(account.id, paths));
		// null override forces the system login even when the default points elsewhere.
		await setActiveClaudeAccount(account.id, paths);
		expect(await getActiveClaudeConfigDir(null, paths)).toBeNull();
	});
});

describe("codex accounts", () => {
	it("import snapshots auth.json into a per-account CODEX_HOME and becomes the default", async () => {
		seedCodexLogin("acc-1");
		const account = await importCurrentCodexAccount(paths);
		expect(account.label).toBe("acc-1@example.com");
		expect(account.identity?.planLabel).toBe("Plus");

		const state = await listAgentAccounts(paths);
		expect(state.codex.activeId).toBe(account.id);
		expect(state.codex.currentIdentity?.accountId).toBe("acc-1");
		// The account dir is a usable CODEX_HOME holding its own auth.json.
		expect(existsSync(join(codexAccountDir(account.id, paths), "auth.json"))).toBe(true);
	});

	it("rejects import without a ChatGPT login", async () => {
		await expect(importCurrentCodexAccount(paths)).rejects.toThrow(/No Codex login/);
	});

	it("prepareCodexLogin scaffolds a fresh CODEX_HOME and hands a scoped login command", async () => {
		const prevHeadless = process.env.DEV3_HEADLESS;
		delete process.env.DEV3_HEADLESS; // desktop: browser OAuth is fine, no --device-auth
		try {
			const { accountId, loginCommand } = await prepareCodexLogin(paths);
			expect(accountId).toBeTruthy();
			const dir = codexAccountDir(accountId, paths);
			expect(loginCommand).toBe(`CODEX_HOME='${dir}' codex login`);
			expect(existsSync(dir)).toBe(true);
			// Not registered until verified — the user's ~/.codex is untouched.
			const state = await listAgentAccounts(paths);
			expect(state.codex.accounts).toHaveLength(0);
		} finally {
			if (prevHeadless === undefined) delete process.env.DEV3_HEADLESS;
			else process.env.DEV3_HEADLESS = prevHeadless;
		}
	});

	it("prepareCodexLogin uses device auth when the viewer is remote, even on a desktop host", async () => {
		const prevHeadless = process.env.DEV3_HEADLESS;
		delete process.env.DEV3_HEADLESS;
		try {
			const { accountId, launch } = await prepareCodexLogin(paths, { deviceAuth: true });
			expect(launch).toEqual({ command: "codex", args: ["login", "--device-auth"], env: { CODEX_HOME: codexAccountDir(accountId, paths) }, cwd: codexAccountDir(accountId, paths) });
		} finally {
			if (prevHeadless === undefined) delete process.env.DEV3_HEADLESS;
			else process.env.DEV3_HEADLESS = prevHeadless;
		}
	});

	it("prepareCodexLogin appends --device-auth on a headless/remote box (no local browser)", async () => {
		const prevHeadless = process.env.DEV3_HEADLESS;
		process.env.DEV3_HEADLESS = "1";
		try {
			const { accountId, loginCommand } = await prepareCodexLogin(paths);
			const dir = codexAccountDir(accountId, paths);
			expect(loginCommand).toBe(`CODEX_HOME='${dir}' codex login --device-auth`);
		} finally {
			if (prevHeadless === undefined) delete process.env.DEV3_HEADLESS;
			else process.env.DEV3_HEADLESS = prevHeadless;
		}
	});

	it("completeCodexLogin verifies the scoped dir and registers it as the default", async () => {
		const { accountId } = await prepareCodexLogin(paths);
		// Simulate `codex login` writing auth.json into the scoped CODEX_HOME.
		writeFileSync(join(codexAccountDir(accountId, paths), "auth.json"), codexAuth("acc-new"));
		const account = await completeCodexLogin(accountId, paths);
		expect(account.identity?.accountId).toBe("acc-new");
		const state = await listAgentAccounts(paths);
		expect(state.codex.activeId).toBe(account.id);
		expect(state.codex.accounts).toHaveLength(1);
	});

	it("resolves and persists the selected ChatGPT workspace name", async () => {
		mockCodexWorkspaceNames([{ id: "workspace-globex", name: "Globex ChatGPT Enterprise" }]);
		const { accountId } = await prepareCodexLogin(paths);
		writeFileSync(
			join(codexAccountDir(accountId, paths), "auth.json"),
			codexAuth("workspace-globex", "shared@example.com"),
		);

		const account = await completeCodexLogin(accountId, paths);

		expect(account.identity?.organization).toBe("Globex ChatGPT Enterprise");
		const registry = JSON.parse(readFileSync(join(paths.accountsDir, "accounts.json"), "utf-8"));
		expect(registry.codex.accounts[0].workspaceName).toBe("Globex ChatGPT Enterprise");
	});

	it("completeCodexLogin rejects a login that duplicates an existing account", async () => {
		seedCodexLogin("acc-1");
		await importCurrentCodexAccount(paths);
		const { accountId } = await prepareCodexLogin(paths);
		writeFileSync(join(codexAccountDir(accountId, paths), "auth.json"), codexAuth("acc-1"));
		await expect(completeCodexLogin(accountId, paths)).rejects.toThrow(/already added/);
	});

	it("names the selected workspace in a duplicate error", async () => {
		mockCodexWorkspaceNames([{ id: "b8e0e9ae-workspace", name: "Globex ChatGPT Enterprise" }]);
		seedCodexLogin("b8e0e9ae-workspace");
		await importCurrentCodexAccount(paths);
		const { accountId } = await prepareCodexLogin(paths);
		writeFileSync(
			join(codexAccountDir(accountId, paths), "auth.json"),
			codexAuth("b8e0e9ae-workspace", "shared@example.com"),
		);

		await expect(completeCodexLogin(accountId, paths)).rejects.toThrow(
			'Codex workspace "Globex ChatGPT Enterprise" (b8e0e9ae) is already added as',
		);
	});

	it("backfills readable names for legacy Codex accounts", async () => {
		seedCodexLogin("workspace-acme");
		const imported = await importCurrentCodexAccount(paths);
		expect(imported.identity?.organization).toBeNull();
		await renameAgentAccount("codex", imported.id, "workspace-acme@example.com (Workspace workspac)", paths);

		mockCodexWorkspaceNames([{ id: "workspace-acme", name: "Acme" }]);
		const state = await listAgentAccounts(paths);

		expect(state.codex.accounts[0]?.identity?.organization).toBe("Acme");
		expect(state.codex.accounts[0]?.label).toBe("workspace-acme@example.com (Acme)");
		expect(state.codex.currentIdentity?.organization).toBe("Acme");
	});

	it("treats the Codex workspace id as authoritative when organization metadata changes", async () => {
		mkdirSync(paths.codexHome, { recursive: true });
		writeFileSync(
			join(paths.codexHome, "auth.json"),
			codexAuth("workspace-same", "shared@example.com", {}, [{ id: "org-1", title: "Acme" }]),
		);
		await importCurrentCodexAccount(paths);

		const { accountId } = await prepareCodexLogin(paths);
		writeFileSync(
			join(codexAccountDir(accountId, paths), "auth.json"),
			codexAuth("workspace-same", "shared@example.com", {}, [{ id: "org-2", title: "Personal" }]),
		);

		await expect(completeCodexLogin(accountId, paths)).rejects.toThrow(/Codex workspace .* is already added/);
	});

	it("allows the same Codex email in different ChatGPT workspaces", async () => {
		seedCodexLogin("11111111-1111-1111-1111-111111111111");
		writeFileSync(
			join(paths.codexHome, "auth.json"),
			codexAuth("11111111-1111-1111-1111-111111111111", "shared@example.com"),
		);
		await importCurrentCodexAccount(paths);

		const { accountId } = await prepareCodexLogin(paths);
		writeFileSync(
			join(codexAccountDir(accountId, paths), "auth.json"),
			codexAuth("22222222-2222-2222-2222-222222222222", "shared@example.com"),
		);

		await expect(completeCodexLogin(accountId, paths)).resolves.toMatchObject({
			label: "shared@example.com (Workspace 22222222)",
			identity: { accountId: "22222222-2222-2222-2222-222222222222", email: "shared@example.com" },
		});
		const state = await listAgentAccounts(paths);
		expect(state.codex.accounts).toHaveLength(2);
	});

	it("setActiveCodexAccount only moves the default pointer — never swaps ~/.codex", async () => {
		seedCodexLogin("acc-sys");
		const original = readFileSync(join(paths.codexHome, "auth.json"), "utf-8");
		const first = await importCurrentCodexAccount(paths);

		await setActiveCodexAccount(first.id, paths);
		let state = await listAgentAccounts(paths);
		expect(state.codex.activeId).toBe(first.id);
		// Activation is registry-only — the system login file is never rewritten.
		expect(readFileSync(join(paths.codexHome, "auth.json"), "utf-8")).toBe(original);

		// null → the system login (~/.codex) becomes the default.
		await setActiveCodexAccount(null, paths);
		state = await listAgentAccounts(paths);
		expect(state.codex.activeId).toBeNull();
	});

	it("identifies the launched Codex home without consulting the current default or credentials", async () => {
		seedCodexLogin("acc-one");
		const first = await importCurrentCodexAccount(paths);
		const launched = await getActiveCodexSessionEnv(undefined, paths);
		seedCodexLogin("acc-two");
		const second = await importCurrentCodexAccount(paths);
		unlinkSync(join(codexAccountDir(first.id, paths), "auth.json"));

		expect(codexAccountIdForHome(launched.CODEX_HOME, paths)).toBe(first.id);
		expect(codexAccountIdForHome(codexAccountDir(second.id, paths), paths)).toBe(second.id);
		expect(codexAccountIdForHome(undefined, paths)).toBeUndefined();
		expect(codexAccountIdForHome(paths.codexHome, paths)).toBeUndefined();
		expect(codexAccountIdForHome(join(root, "custom-home"), paths)).toBeUndefined();
		expect(codexAccountIdForHome(join(codexAccountDir(first.id, paths), "sessions"), paths)).toBeUndefined();
	});

	it("getActiveCodexSessionEnv injects the selected account's CODEX_HOME; per-launch override wins", async () => {
		seedCodexLogin("acc-1");
		const account = await importCurrentCodexAccount(paths);
		// Default points at the imported account.
		expect(await getActiveCodexSessionEnv(undefined, paths)).toEqual({ CODEX_HOME: codexAccountDir(account.id, paths) });
		// null override → system login (~/.codex), no CODEX_HOME.
		expect(await getActiveCodexSessionEnv(null, paths)).toEqual({});
		// Explicit id override selects that account even when the default is the system login.
		await setActiveCodexAccount(null, paths);
		expect(await getActiveCodexSessionEnv(account.id, paths)).toEqual({ CODEX_HOME: codexAccountDir(account.id, paths) });
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

		const env = await getActiveClaudeSessionEnv(undefined, paths);
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

		const env = await getActiveClaudeSessionEnv(undefined, paths);
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("provider/fast");
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME).toBe("Fast");
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION).toBe("Cheap background model");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("provider/smart");
		// Untouched slots are actively unset.
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(ENV_UNSET);
	});

	it("active OAuth account injects CLAUDE_CONFIG_DIR and unsets every API-profile var; empty registry injects nothing", async () => {
		seedClaudeLogin();
		expect(await getActiveClaudeSessionEnv(undefined, paths)).toEqual({});

		const account = await importCurrentClaudeAccount(paths);
		await setActiveClaudeAccount(account.id, paths);
		const env = await getActiveClaudeSessionEnv(undefined, paths);
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
		const env = await getActiveClaudeSessionEnv(undefined, paths);
		for (const key of claudeApiProfileEnvKeys()) {
			expect(env[key]).toBe(ENV_UNSET);
		}
	});

	it("switching to OAuth unsets extra env vars carried by an inactive API profile", async () => {
		seedClaudeLogin();
		await addClaudeApiProfile({ apiKey: "sk-x", env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, paths);
		const oauth = await importCurrentClaudeAccount(paths);
		await setActiveClaudeAccount(oauth.id, paths);
		const env = await getActiveClaudeSessionEnv(undefined, paths);
		expect(env.CLAUDE_CODE_USE_BEDROCK).toBe(ENV_UNSET);
		expect(env.ANTHROPIC_API_KEY).toBe(ENV_UNSET);
	});

	it("remove deletes the profile dir together with its key", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile({ apiKey: "sk-x" }, paths);
		expect(account.label).toBe("API profile 1");
		await removeAgentAccount("claude", account.id, paths);
		expect(existsSync(claudeAccountDir(account.id, paths))).toBe(false);
		expect(await getActiveClaudeSessionEnv(undefined, paths)).toEqual({});
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
		const env = await getActiveClaudeSessionEnv(undefined, paths);
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
		const env = await getActiveClaudeSessionEnv(undefined, paths);
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("provider/sonnet");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(ENV_UNSET);
	});

	it("update replaces the key and re-approves its tail when a new key is given", async () => {
		seedClaudeLogin();
		const account = await addClaudeApiProfile({ apiKey: "sk-original-key" }, paths);
		await updateClaudeApiProfile(account.id, { apiKey: "sk-brand-new-key-1234567890" }, paths);
		await setActiveClaudeAccount(account.id, paths);
		expect((await getActiveClaudeSessionEnv(undefined, paths)).ANTHROPIC_API_KEY).toBe("sk-brand-new-key-1234567890");
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

	it("remove rejects path-traversal account ids without touching disk", async () => {
		mkdirSync(join(root, "victim"), { recursive: true });
		writeFileSync(join(root, "victim", "file.txt"), "keep me");
		// claudeAccountDir(accountsDir, "claude", "../../victim") would resolve to
		// the victim dir — the id must be rejected before any rmSync.
		await expect(removeAgentAccount("claude", "../../victim", paths)).rejects.toThrow(/Invalid account id/);
		await expect(removeAgentAccount("codex", "../../victim", paths)).rejects.toThrow(/Invalid account id/);
		expect(existsSync(join(root, "victim", "file.txt"))).toBe(true);
	});

	it("completeClaudeLogin rejects path-traversal account ids", async () => {
		seedClaudeLogin();
		await expect(completeClaudeLogin("../../.claude", paths, unavailableStatus)).rejects.toThrow(/Invalid account id/);
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

describe("omp accounts", () => {
	const chatgpt: OmpLogin = { provider: "openai-codex", identityKey: "email:dev@example.com|org:ws-1", orgName: "plus" };

	function seedOmpAgentHome() {
		const home = paths.ompAgentHome!;
		mkdirSync(join(home, "skills", "dev3"), { recursive: true });
		mkdirSync(join(home, "sessions"), { recursive: true });
		writeFileSync(join(home, "config.yml"), "theme: dark\n");
		writeFileSync(join(home, "agent.db"), "user's own credentials");
		writeFileSync(join(home, "agent.db-wal"), "");
		writeFileSync(join(home, "models.db"), "");
	}

	async function addOmpAccount(logins: OmpLogin[] = [chatgpt]) {
		const { accountId } = await prepareOmpLogin(paths);
		return completeOmpLogin(accountId, paths, async () => logins);
	}

	it("keeps sessions and every SQLite file private, shares the rest", () => {
		for (const entry of ["agent.db", "agent.db-wal", "models.db-shm", "sessions", "cache", "auth-broker.token"]) {
			expect(isPrivateOmpEntry(entry)).toBe(true);
		}
		for (const entry of ["config.yml", "skills", "extensions", "models.yml", "AGENTS.md"]) {
			expect(isPrivateOmpEntry(entry)).toBe(false);
		}
	});

	it("prepares a fresh agent dir linking the user's config but not their credentials", async () => {
		seedOmpAgentHome();
		const { accountId, loginCommand, launch } = await prepareOmpLogin(paths);
		const dir = ompAccountDir(accountId, paths);
		expect(loginCommand).toBe(`PI_CODING_AGENT_DIR='${dir}' omp login`);
		expect(launch).toEqual({ command: "omp", args: ["login"], env: { PI_CODING_AGENT_DIR: dir }, cwd: dir });
		expect(existsSync(join(dir, STAGED_LOGIN_MARKER))).toBe(true);
		expect(lstatSync(join(dir, "config.yml")).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(dir, "skills")).isSymbolicLink()).toBe(true);
		for (const entry of ["agent.db", "agent.db-wal", "models.db", "sessions"]) {
			expect(existsSync(join(dir, entry))).toBe(false);
		}
		// Not registered until a sign-in is verified.
		expect((await listAgentAccounts(paths)).omp.accounts).toHaveLength(0);
	});

	it("keeps waiting on an agent dir with no sign-in, and on a listing that fails", async () => {
		const { accountId } = await prepareOmpLogin(paths);
		await expect(completeOmpLogin(accountId, paths, async () => [])).rejects.toBeInstanceOf(LoginNotReadyError);
		const failing = async (): Promise<OmpLogin[]> => {
			throw new Error("omp usage accounts exited with code 1");
		};
		await expect(completeOmpLogin(accountId, paths, failing)).rejects.toBeInstanceOf(LoginNotReadyError);
		expect((await listAgentAccounts(paths)).omp.accounts).toHaveLength(0);
	});

	it("asks omp again only after its auth store changed", async () => {
		const { accountId } = await prepareOmpLogin(paths);
		const dir = ompAccountDir(accountId, paths);
		expect(stagedLoginHasIdentity("omp", accountId, paths)).toBe(true);
		await expect(completeOmpLogin(accountId, paths, async () => [])).rejects.toBeInstanceOf(LoginNotReadyError);
		expect(stagedLoginHasIdentity("omp", accountId, paths)).toBe(false);
		writeFileSync(join(dir, "agent.db"), "x");
		expect(stagedLoginHasIdentity("omp", accountId, paths)).toBe(true);
	});

	it("a verified login drops the staged marker and can no longer be discarded", async () => {
		const account = await addOmpAccount();
		const dir = ompAccountDir(account.id, paths);
		expect(existsSync(join(dir, STAGED_LOGIN_MARKER))).toBe(false);
		expect(discardStagedLogin("omp", account.id, paths)).toBe(false);
		expect(existsSync(dir)).toBe(true);
	});

	it("discards an unverified staged dir and sweeps an abandoned one", async () => {
		const { accountId } = await prepareOmpLogin(paths);
		expect(discardStagedLogin("omp", accountId, paths)).toBe(true);
		expect(existsSync(ompAccountDir(accountId, paths))).toBe(false);
		const stale = await prepareOmpLogin(paths);
		expect(sweepAbandonedStagedLogins("omp", 60_000, Date.now() + 120_000, paths)).toBe(1);
		expect(existsSync(ompAccountDir(stale.accountId, paths))).toBe(false);
	});

	it("registers a verified login as the default, labelled by its email", async () => {
		const account = await addOmpAccount([chatgpt, { provider: "github-copilot", identityKey: null, orgName: null }]);
		expect(account.label).toBe("dev@example.com");
		expect(account.identity?.planLabel).toBe("openai-codex, github-copilot");
		const state = await listAgentAccounts(paths);
		expect(state.omp.accounts.map((a) => a.id)).toEqual([account.id]);
		expect(state.omp.activeId).toBe(account.id);
	});

	it("keeps the omp registry out of accounts.json, which older builds rewrite", async () => {
		await addOmpAccount();
		expect(existsSync(join(paths.accountsDir, "omp-accounts.json"))).toBe(true);
		expect(existsSync(join(paths.accountsDir, "accounts.json"))).toBe(false);
	});

	it("injects nothing while no omp account exists", async () => {
		expect(await getActiveOmpSessionEnv(undefined, paths)).toEqual({});
	});

	it("points PI_CODING_AGENT_DIR at the selected account and unsets it for the system login", async () => {
		const account = await addOmpAccount();
		const dir = ompAccountDir(account.id, paths);
		expect(await getActiveOmpSessionEnv(undefined, paths)).toEqual({ PI_CODING_AGENT_DIR: dir });
		expect(await getActiveOmpSessionEnv(null, paths)).toEqual({ PI_CODING_AGENT_DIR: ENV_UNSET });
		await setActiveOmpAccount(null, paths);
		expect(await getActiveOmpSessionEnv(undefined, paths)).toEqual({ PI_CODING_AGENT_DIR: ENV_UNSET });
		expect(await getActiveOmpSessionEnv(account.id, paths)).toEqual({ PI_CODING_AGENT_DIR: dir });
	});

	it("links entries that appeared in ~/.omp/agent after the account was created", async () => {
		const account = await addOmpAccount();
		mkdirSync(join(paths.ompAgentHome!, "extensions"), { recursive: true });
		await getActiveOmpSessionEnv(account.id, paths);
		expect(lstatSync(join(ompAccountDir(account.id, paths), "extensions")).isSymbolicLink()).toBe(true);
	});

	it("re-verifying an account refreshes its sign-ins without a second row", async () => {
		const account = await addOmpAccount();
		await completeOmpLogin(account.id, paths, async () => [chatgpt, { provider: "xai-oauth", identityKey: "email:x@example.com", orgName: null }]);
		const [row] = (await listAgentAccounts(paths)).omp.accounts;
		expect(row.ompLogins?.map((l) => l.provider)).toEqual(["openai-codex", "xai-oauth"]);
		expect((await listAgentAccounts(paths)).omp.accounts).toHaveLength(1);
	});

	it("renames and removes an omp account without touching ~/.omp/agent", async () => {
		seedOmpAgentHome();
		const account = await addOmpAccount();
		await renameAgentAccount("omp", account.id, "Work ChatGPT", paths);
		expect((await listAgentAccounts(paths)).omp.accounts[0].label).toBe("Work ChatGPT");
		await removeAgentAccount("omp", account.id, paths);
		const state = await listAgentAccounts(paths);
		expect(state.omp.accounts).toHaveLength(0);
		expect(state.omp.activeId).toBeNull();
		expect(existsSync(ompAccountDir(account.id, paths))).toBe(false);
		expect(readFileSync(join(paths.ompAgentHome!, "config.yml"), "utf-8")).toBe("theme: dark\n");
		expect(existsSync(join(paths.ompAgentHome!, "skills", "dev3"))).toBe(true);
	});
});
