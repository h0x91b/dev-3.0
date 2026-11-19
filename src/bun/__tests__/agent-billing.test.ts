import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptBilling, codexRolloutBilling, parseProviderAuthTypes, providerBilling } from "../../shared/agent-billing";
import { readProviderAuthTypes } from "../usage-collectors/provider-auth";

const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const assistantLine = { type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 1 } } };

describe("claudeTranscriptBilling", () => {
	it("reads a claude.ai login from the session-owner line, wherever it sits in the file", () => {
		const owner = { type: "session-owner", accountUuid: "acc", organizationUuid: "org", sessionId: "s" };
		expect(claudeTranscriptBilling(jsonl(assistantLine, assistantLine, owner))).toBe("subscription");
		expect(claudeTranscriptBilling(jsonl(owner, assistantLine))).toBe("subscription");
	});

	it("never reads a missing owner as API spend: older CLIs, setup tokens and API keys all lack it", () => {
		expect(claudeTranscriptBilling(jsonl(assistantLine))).toBeUndefined();
		expect(claudeTranscriptBilling(jsonl({ type: "session-owner", accountUuid: "", sessionId: "s" }))).toBeUndefined();
	});

	it("ignores the string inside conversation text and a torn last line", () => {
		const quoted = { type: "user", message: { content: "grep \"session-owner\" in the logs" } };
		expect(claudeTranscriptBilling(jsonl(quoted))).toBeUndefined();
		expect(claudeTranscriptBilling(`${jsonl(assistantLine)}\n{"type":"session-owner","accountUuid":"a`)).toBeUndefined();
	});
});

describe("codexRolloutBilling", () => {
	const tokenCount = (rateLimits: unknown) => ({ type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: rateLimits } });

	it("treats a ChatGPT plan_type as plan-covered usage", () => {
		expect(codexRolloutBilling(jsonl(tokenCount({ plan_type: "prolite" })))).toBe("subscription");
		expect(codexRolloutBilling(jsonl(tokenCount({ plan_type: null }), tokenCount({ plan_type: "plus" })))).toBe("subscription");
	});

	it("leaves rollouts without a plan unknown", () => {
		expect(codexRolloutBilling(jsonl(tokenCount({ plan_type: null })))).toBeUndefined();
		expect(codexRolloutBilling(jsonl(tokenCount(null)))).toBeUndefined();
		expect(codexRolloutBilling("")).toBeUndefined();
	});
});

describe("providerBilling", () => {
	it("classifies plan-only and pay-per-token providers without an auth file", () => {
		expect(providerBilling("openai-codex")).toBe("subscription");
		expect(providerBilling("github-copilot")).toBe("subscription");
		expect(providerBilling("openrouter")).toBe("api");
		expect(providerBilling("Cerebras")).toBe("api");
	});

	it("resolves an ambiguous provider only from the auth file, otherwise unknown", () => {
		const auth = parseProviderAuthTypes({ anthropic: { type: "api", key: "sk-secret" }, openai: { type: "oauth", refresh: "x" } });
		expect(providerBilling("anthropic", auth)).toBe("api");
		expect(providerBilling("openai", auth)).toBe("subscription");
		expect(providerBilling("anthropic")).toBeUndefined();
		expect(providerBilling("google", auth)).toBeUndefined();
		expect(providerBilling(undefined, auth)).toBeUndefined();
	});

	it("keeps only the login kind of each provider, never a credential", () => {
		const auth = parseProviderAuthTypes({ anthropic: { type: "api", key: "sk-secret" } });
		expect([...auth]).toEqual([["anthropic", "api"]]);
	});
});

describe("readProviderAuthTypes", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "provider-auth-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reads pi's api_key type and treats a missing or broken file as no evidence", () => {
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "k" } }));
		expect(providerBilling("anthropic", readProviderAuthTypes(join(dir, "auth.json")))).toBe("api");
		expect(readProviderAuthTypes(join(dir, "missing.json")).size).toBe(0);
		writeFileSync(join(dir, "broken.json"), "{");
		expect(readProviderAuthTypes(join(dir, "broken.json")).size).toBe(0);
	});
});
