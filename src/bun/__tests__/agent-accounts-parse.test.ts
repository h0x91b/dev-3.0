import { describe, expect, it } from "vitest";
import {
	claudePlanLabel,
	codexPlanLabel,
	decodeJwtPayload,
	defaultAccountLabel,
	providerLoginsIdentity,
	parsePiAuthLogins,
	providerLoginEmail,
	parseOmpAccounts,
	defaultApiProfileLabel,
	shortClaudeConfigDir,
	parseClaudeIdentity,
	parseCodexIdentity,
	parseEnvLines,
	shortCodexWorkspaceId,
} from "../../shared/agent-accounts";

function makeJwt(payload: Record<string, unknown>): string {
	const b64url = (obj: unknown) =>
		Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${b64url({ alg: "RS256" })}.${b64url(payload)}.signature`;
}

describe("claudePlanLabel", () => {
	it("maps max and pro tiers, returns null for empty/default, title-cases unknown ones", () => {
		expect(claudePlanLabel("default_claude_max_5x"), "maps max tiers").toBe("Max 5x");
		expect(claudePlanLabel("default_claude_max_20x"), "maps max tiers").toBe("Max 20x");
		expect(claudePlanLabel("default_claude_pro"), "maps pro tier").toBe("Pro");
		expect(claudePlanLabel(null), "returns null for empty/default tiers").toBeNull();
		expect(claudePlanLabel("default"), "returns null for empty/default tiers").toBeNull();
		expect(claudePlanLabel("some_new_tier"), "title-cases unknown tiers").toBe("Some New Tier");
	});
});

describe("codexPlanLabel", () => {
	it("maps simple plans, collapses enterprise variants, title-cases unknown compounds, null for null", () => {
		expect(codexPlanLabel("plus"), "maps simple plans").toBe("Plus");
		expect(codexPlanLabel("pro"), "maps simple plans").toBe("Pro");
		expect(codexPlanLabel("enterprise_cbp_usage_based"), "collapses enterprise billing-mode variants to Enterprise").toBe("Enterprise");
		expect(codexPlanLabel("enterprise"), "collapses enterprise billing-mode variants to Enterprise").toBe("Enterprise");
		expect(codexPlanLabel("some_new_plan"), "title-cases unknown compound plans").toBe("Some New Plan");
		expect(codexPlanLabel(null), "returns null for null").toBeNull();
	});
});

describe("parseClaudeIdentity", () => {
	it("parses oauthAccount fields", () => {
		const identity = parseClaudeIdentity({
			oauthAccount: {
				emailAddress: "dev@example.com",
				organizationName: "Acme",
				userRateLimitTier: "default_claude_max_5x",
				accountUuid: "uuid-1",
				organizationUuid: "org-uuid-1",
			},
		});
		expect(identity).toEqual({
			email: "dev@example.com",
			organization: "Acme",
			plan: "default_claude_max_5x",
			planLabel: "Max 5x",
			accountId: "uuid-1",
			organizationId: "org-uuid-1",
		});
	});

	it("returns null without oauthAccount and tolerates a partial one", () => {
		expect(parseClaudeIdentity({}), "returns null without oauthAccount").toBeNull();
		expect(parseClaudeIdentity(null), "returns null without oauthAccount").toBeNull();
		expect(parseClaudeIdentity("nope"), "returns null without oauthAccount").toBeNull();
		const identity = parseClaudeIdentity({ oauthAccount: { emailAddress: "a@b.c" } });
		expect(identity?.email, "tolerates partial oauthAccount").toBe("a@b.c");
		expect(identity?.plan, "tolerates partial oauthAccount").toBeNull();
		expect(identity?.accountId, "tolerates partial oauthAccount").toBeNull();
	});
});

describe("decodeJwtPayload", () => {
	it("decodes a base64url payload and returns null for malformed input", () => {
		const jwt = makeJwt({ email: "x@y.z" });
		expect(decodeJwtPayload(jwt)?.email, "decodes a base64url payload").toBe("x@y.z");
		expect(decodeJwtPayload("not-a-jwt"), "returns null for malformed input").toBeNull();
		expect(decodeJwtPayload("a.%%%.c"), "returns null for malformed input").toBeNull();
	});
});

describe("parseCodexIdentity", () => {
	it("parses tokens + id_token claims", () => {
		const identity = parseCodexIdentity({
			auth_mode: "ChatGPT",
			tokens: {
				id_token: makeJwt({
					email: "codex@example.com",
					"https://api.openai.com/auth": {
						chatgpt_plan_type: "plus",
						chatgpt_account_id: "acc-1",
						chatgpt_user_id: "user-1",
						organizations: [{ id: "org-1", title: "Acme Org" }],
					},
				}),
				account_id: "acc-1",
			},
			last_refresh: "2026-07-01T00:00:00Z",
		});
		expect(identity).toEqual({
			email: "codex@example.com",
			organization: null,
			plan: "plus",
			planLabel: "Plus",
			accountId: "acc-1",
			userId: "user-1",
		});
	});

	it("does not mistake the default API organization for the selected ChatGPT workspace", () => {
		const identity = parseCodexIdentity({
			tokens: {
				id_token: makeJwt({
					"https://api.openai.com/auth": {
						chatgpt_account_id: "workspace-globex",
						organizations: [{ id: "org-acme", title: "Acme", is_default: true }],
					},
				}),
				account_id: "workspace-globex",
			},
		});

		expect(identity).toMatchObject({ accountId: "workspace-globex", organization: null });
	});

	it("falls back to the JWT chatgpt_account_id, and returns null without tokens", () => {
		const identity = parseCodexIdentity({
			tokens: {
				id_token: makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-2" } }),
			},
		});
		expect(identity?.accountId, "falls back to the JWT chatgpt_account_id when tokens.account_id is missing").toBe("acc-2");
		expect(parseCodexIdentity({}), "returns null without tokens").toBeNull();
		expect(parseCodexIdentity(null), "returns null without tokens").toBeNull();
	});

	it("derives a compact display id from the selected ChatGPT workspace", () => {
		expect(
			shortCodexWorkspaceId({
				email: "codex@example.com",
				organization: null,
				plan: "plus",
				planLabel: "Plus",
				accountId: "81b5a3a4-9199-40e2-bcde-a6d3ebc9d654",
			}),
		).toBe("81b5a3a4");
		expect(shortCodexWorkspaceId(null)).toBeNull();
	});
});

describe("defaultAccountLabel", () => {
	it("prefers the email, else an ordinal", () => {
		expect(
			defaultAccountLabel({ email: "a@b.c", organization: null, plan: null, planLabel: null, accountId: null }, 1),
		).toBe("a@b.c");
		expect(defaultAccountLabel(null, 3), "falls back to an ordinal").toBe("Account 3");
	});
});

describe("parseEnvLines", () => {
	it("parses KEY=value lines (skipping blanks/comments, keeping '=' in values) and throws on malformed lines", () => {
		expect(parseEnvLines("A=1\n\n# comment\nB = two words \n"), "parses KEY=value lines, skipping blanks and comments").toEqual({ A: "1", B: "two words" });
		expect(parseEnvLines("URL=https://x?a=b=c"), "keeps '=' inside values").toEqual({ URL: "https://x?a=b=c" });
		expect(() => parseEnvLines("no-equals-here"), "throws on malformed lines and bad key names").toThrow(/Invalid env line/);
		expect(() => parseEnvLines("1BAD=x"), "throws on malformed lines and bad key names").toThrow(/Invalid env line/);
		expect(() => parseEnvLines("=value"), "throws on malformed lines and bad key names").toThrow(/Invalid env line/);
	});
});

describe("defaultApiProfileLabel", () => {
	it("uses the base URL host, else an ordinal", () => {
		expect(defaultApiProfileLabel("https://openrouter.ai/api/v1", 1), "uses the base URL host when available").toBe("openrouter.ai");
		expect(defaultApiProfileLabel(null, 2), "falls back to an ordinal for missing or unparsable URLs").toBe("API profile 2");
		expect(defaultApiProfileLabel("not a url", 3), "falls back to an ordinal for missing or unparsable URLs").toBe("API profile 3");
	});
});

describe("shortClaudeConfigDir", () => {
	it("keeps the last two segments of a long path", () => {
		expect(shortClaudeConfigDir("/mnt/e/Projects/dev/.claude")).toBe("…/dev/.claude");
		expect(shortClaudeConfigDir("/x/.claude")).toBe("/x/.claude");
	});
});

describe("omp accounts parsing", () => {
	it("reads `omp usage accounts --json` rows and fails loudly on any other shape", () => {
		const logins = parseOmpAccounts({
			accounts: [
				{ provider: "openai-codex", identityKey: "email:dev@example.com|org:ws-1", orgName: "plus" },
				{ provider: "github-copilot", identityKey: null },
				{ identityKey: "no provider — dropped" },
			],
		});
		expect(logins, "reads `omp usage accounts --json` rows").toEqual([
			{ provider: "openai-codex", identityKey: "email:dev@example.com|org:ws-1", orgName: "plus" },
			{ provider: "github-copilot", identityKey: null, orgName: null },
		]);
		expect(() => parseOmpAccounts({ rows: [] }), "fails loudly on a payload that is not that shape").toThrow();
		expect(() => parseOmpAccounts(null), "fails loudly on a payload that is not that shape").toThrow();
	});

	it("takes the email out of an identity key, names an account by its first emailed sign-in and badges every provider once", () => {
		expect(providerLoginEmail({ provider: "p", identityKey: "org:x|email:a@b.c", orgName: null }), "takes the email segment out of an identity key").toBe("a@b.c");
		expect(providerLoginEmail({ provider: "p", identityKey: "org:x", orgName: null }), "takes the email segment out of an identity key").toBeNull();
		const identity = providerLoginsIdentity([
			{ provider: "github-copilot", identityKey: null, orgName: null },
			{ provider: "openai-codex", identityKey: "email:dev@example.com", orgName: "plus" },
			{ provider: "openai-codex", identityKey: "email:other@example.com", orgName: null },
		]);
		expect(identity, "names an account by its first emailed sign-in and badges every provider once").toEqual({ email: "dev@example.com", organization: "plus", plan: null, planLabel: "github-copilot, openai-codex", accountId: null });
		expect(providerLoginsIdentity([]), "names an account by its first emailed sign-in and badges every provider once").toBeNull();
	});
});

describe("parsePiAuthLogins", () => {
	it("lists providers with a credential type and drops every secret value", () => {
		const logins = parsePiAuthLogins({
			anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
			openrouter: { type: "api_key", key: "!security find-generic-password -ws openrouter" },
			weird: { type: "something-else" },
			broken: "not an object",
		});
		expect(logins).toEqual([
			{ provider: "anthropic", identityKey: null, orgName: null, authType: "oauth" },
			{ provider: "openrouter", identityKey: null, orgName: null, authType: "api_key" },
		]);
		expect(JSON.stringify(logins)).not.toContain("security");
	});

	it("throws on content that is not an object, so a broken file never reads as signed out", () => {
		expect(() => parsePiAuthLogins([])).toThrow();
		expect(() => parsePiAuthLogins(null)).toThrow();
	});
});
