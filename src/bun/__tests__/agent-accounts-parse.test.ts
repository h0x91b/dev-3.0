import { describe, expect, it } from "vitest";
import {
	claudePlanLabel,
	codexPlanLabel,
	decodeJwtPayload,
	defaultAccountLabel,
	defaultApiProfileLabel,
	parseClaudeIdentity,
	parseCodexIdentity,
	parseEnvLines,
} from "../../shared/agent-accounts";

function makeJwt(payload: Record<string, unknown>): string {
	const b64url = (obj: unknown) =>
		Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${b64url({ alg: "RS256" })}.${b64url(payload)}.signature`;
}

describe("claudePlanLabel", () => {
	it("maps max tiers", () => {
		expect(claudePlanLabel("default_claude_max_5x")).toBe("Max 5x");
		expect(claudePlanLabel("default_claude_max_20x")).toBe("Max 20x");
	});

	it("maps pro tier", () => {
		expect(claudePlanLabel("default_claude_pro")).toBe("Pro");
	});

	it("returns null for empty/default tiers", () => {
		expect(claudePlanLabel(null)).toBeNull();
		expect(claudePlanLabel("default")).toBeNull();
	});

	it("title-cases unknown tiers", () => {
		expect(claudePlanLabel("some_new_tier")).toBe("Some New Tier");
	});
});

describe("codexPlanLabel", () => {
	it("maps simple plans", () => {
		expect(codexPlanLabel("plus")).toBe("Plus");
		expect(codexPlanLabel("pro")).toBe("Pro");
	});

	it("collapses enterprise billing-mode variants to Enterprise", () => {
		expect(codexPlanLabel("enterprise_cbp_usage_based")).toBe("Enterprise");
		expect(codexPlanLabel("enterprise")).toBe("Enterprise");
	});

	it("title-cases unknown compound plans", () => {
		expect(codexPlanLabel("some_new_plan")).toBe("Some New Plan");
	});

	it("returns null for null", () => {
		expect(codexPlanLabel(null)).toBeNull();
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
			},
		});
		expect(identity).toEqual({
			email: "dev@example.com",
			organization: "Acme",
			plan: "default_claude_max_5x",
			planLabel: "Max 5x",
			accountId: "uuid-1",
		});
	});

	it("returns null without oauthAccount", () => {
		expect(parseClaudeIdentity({})).toBeNull();
		expect(parseClaudeIdentity(null)).toBeNull();
		expect(parseClaudeIdentity("nope")).toBeNull();
	});

	it("tolerates partial oauthAccount", () => {
		const identity = parseClaudeIdentity({ oauthAccount: { emailAddress: "a@b.c" } });
		expect(identity?.email).toBe("a@b.c");
		expect(identity?.plan).toBeNull();
		expect(identity?.accountId).toBeNull();
	});
});

describe("decodeJwtPayload", () => {
	it("decodes a base64url payload", () => {
		const jwt = makeJwt({ email: "x@y.z" });
		expect(decodeJwtPayload(jwt)?.email).toBe("x@y.z");
	});

	it("returns null for malformed input", () => {
		expect(decodeJwtPayload("not-a-jwt")).toBeNull();
		expect(decodeJwtPayload("a.%%%.c")).toBeNull();
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
						organizations: [{ id: "org-1", title: "Acme Org" }],
					},
				}),
				account_id: "acc-1",
			},
			last_refresh: "2026-07-01T00:00:00Z",
		});
		expect(identity).toEqual({
			email: "codex@example.com",
			organization: "Acme Org",
			plan: "plus",
			planLabel: "Plus",
			accountId: "acc-1",
		});
	});

	it("falls back to the JWT chatgpt_account_id when tokens.account_id is missing", () => {
		const identity = parseCodexIdentity({
			tokens: {
				id_token: makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-2" } }),
			},
		});
		expect(identity?.accountId).toBe("acc-2");
	});

	it("returns null without tokens", () => {
		expect(parseCodexIdentity({})).toBeNull();
		expect(parseCodexIdentity(null)).toBeNull();
	});
});

describe("defaultAccountLabel", () => {
	it("prefers the email", () => {
		expect(
			defaultAccountLabel({ email: "a@b.c", organization: null, plan: null, planLabel: null, accountId: null }, 1),
		).toBe("a@b.c");
	});

	it("falls back to an ordinal", () => {
		expect(defaultAccountLabel(null, 3)).toBe("Account 3");
	});
});

describe("parseEnvLines", () => {
	it("parses KEY=value lines, skipping blanks and comments", () => {
		expect(parseEnvLines("A=1\n\n# comment\nB = two words \n")).toEqual({ A: "1", B: "two words" });
	});

	it("keeps '=' inside values", () => {
		expect(parseEnvLines("URL=https://x?a=b=c")).toEqual({ URL: "https://x?a=b=c" });
	});

	it("throws on malformed lines and bad key names", () => {
		expect(() => parseEnvLines("no-equals-here")).toThrow(/Invalid env line/);
		expect(() => parseEnvLines("1BAD=x")).toThrow(/Invalid env line/);
		expect(() => parseEnvLines("=value")).toThrow(/Invalid env line/);
	});
});

describe("defaultApiProfileLabel", () => {
	it("uses the base URL host when available", () => {
		expect(defaultApiProfileLabel("https://openrouter.ai/api/v1", 1)).toBe("openrouter.ai");
	});

	it("falls back to an ordinal for missing or unparsable URLs", () => {
		expect(defaultApiProfileLabel(null, 2)).toBe("API profile 2");
		expect(defaultApiProfileLabel("not a url", 3)).toBe("API profile 3");
	});
});
