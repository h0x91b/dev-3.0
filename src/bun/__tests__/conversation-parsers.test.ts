import { describe, expect, it } from "vitest";
import {
	detectConversationSource,
	parseClaudeTranscript,
	parseCodexTranscript,
} from "../../shared/conversation-parsers";
import { conversationEvents, scanJsonl, type ParsedConversation } from "../../shared/conversation-model";

/** The conversation layer, flattened out of the turns. */
const ev = (parsed: ParsedConversation) => conversationEvents(parsed);

/** Records are shaped after the real on-disk transcripts, trimmed to what the parser reads. */
function jsonl(...records: unknown[]): string {
	return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

const claudeUser = {
	type: "user",
	uuid: "u1",
	parentUuid: null,
	sessionId: "sess-1",
	cwd: "/w",
	gitBranch: "main",
	timestamp: "2026-08-17T10:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text: "parse this" }] },
};

const claudeAssistant = {
	type: "assistant",
	uuid: "a1",
	parentUuid: "u1",
	sessionId: "sess-1",
	timestamp: "2026-08-17T10:00:05.000Z",
	message: {
		role: "assistant",
		model: "claude-opus-5",
		content: [
			{ type: "thinking", thinking: "weighing it", signature: "sig" },
			{ type: "text", text: "on it" },
			{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/w/a.ts" } },
		],
		usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
	},
};

const claudeToolResult = {
	type: "user",
	uuid: "u2",
	parentUuid: "a1",
	sessionId: "sess-1",
	timestamp: "2026-08-17T10:00:06.000Z",
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }] },
};

describe("parseClaudeTranscript", () => {
	it("splits one assistant record into its per-block events", () => {
		const parsed = parseClaudeTranscript(jsonl(claudeUser, claudeAssistant), "/t.jsonl");

		expect(parsed.source).toBe("claude");
		expect(parsed.sessionId).toBe("sess-1");
		expect(parsed.cwd).toBe("/w");
		expect(parsed.gitBranch).toBe("main");
		expect(parsed.model).toBe("claude-opus-5");
		expect(ev(parsed).map((e) => e.kind)).toEqual(["message", "thinking", "message", "tool-call"]);
		expect(ev(parsed)[3].tool).toMatchObject({ callId: "toolu_1", name: "Read" });
		expect(parsed.stats.thinkingBlocks).toBe(1);
		expect(parsed.stats.toolCalls).toBe(1);
	});

	it("reads a thinking block from `thinking`, not `text`", () => {
		const parsed = parseClaudeTranscript(jsonl(claudeAssistant), "/t.jsonl");
		expect(ev(parsed).find((e) => e.kind === "thinking")?.text).toBe("weighing it");
	});

	it("keeps a signature-only thinking block as evidence that reasoning happened", () => {
		const redacted = {
			...claudeAssistant,
			message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] },
		};
		const parsed = parseClaudeTranscript(jsonl(redacted), "/t.jsonl");
		expect(parsed.stats.thinkingBlocks).toBe(1);
		expect(ev(parsed)[0]).toMatchObject({ kind: "thinking", meta: { redacted: true } });
		expect(ev(parsed)[0].text).toBeUndefined();
	});

	it("keeps the parent pointer so the thread stays reconstructable", () => {
		const parsed = parseClaudeTranscript(jsonl(claudeUser, claudeAssistant), "/t.jsonl");
		expect(ev(parsed)[0].parentId).toBeNull();
		expect(ev(parsed)[1].parentId).toBe("u1");
	});

	it("pairs a tool result to its call by id, not by adjacency", () => {
		const parsed = parseClaudeTranscript(jsonl(claudeAssistant, claudeUser, claudeToolResult), "/t.jsonl");
		const call = ev(parsed).find((e) => e.kind === "tool-call");
		const result = ev(parsed).find((e) => e.kind === "tool-result");
		expect(result?.tool?.callId).toBe(call?.tool?.callId);
		expect(result?.tool?.output).toBe("file body");
		expect(result?.role).toBe("tool");
	});

	it("sums token usage across assistant records", () => {
		const parsed = parseClaudeTranscript(jsonl(claudeAssistant), "/t.jsonl");
		expect(parsed.stats.usage).toEqual({ input: 3, output: 40, cacheRead: 100, cacheWrite: 7 });
	});

	it("keeps per-record usage when streaming splits a turn into blockless records", () => {
		// Real transcripts bill a thinking-only record separately from the text one;
		// counting usage per block would drop most of a session's output tokens.
		const thinkingOnly = {
			...claudeAssistant,
			uuid: "a0",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "", signature: "sig" }],
				usage: { input_tokens: 1, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		};
		const parsed = parseClaudeTranscript(jsonl(thinkingOnly, claudeAssistant), "/t.jsonl");
		expect(parsed.stats.usage.output).toBe(540);
		expect(ev(parsed)[0].usage?.output).toBe(500);
	});

	it("records the time span from the first and last timestamps", () => {
		const parsed = parseClaudeTranscript(jsonl(claudeUser, claudeToolResult), "/t.jsonl");
		expect(parsed.startedAt).toBe("2026-08-17T10:00:00.000Z");
		expect(parsed.endedAt).toBe("2026-08-17T10:00:06.000Z");
	});

	it("keeps bookkeeping records as lifecycle instead of dropping them", () => {
		const parsed = parseClaudeTranscript(
			jsonl({ type: "ai-title", aiTitle: "Parse conversations", sessionId: "sess-1" }, claudeUser),
			"/t.jsonl",
		);
		expect(parsed.title).toBe("Parse conversations");
		expect(parsed.sessionEvents[0].kind).toBe("lifecycle");
		expect(parsed.stats.unknownRecords).toBe(0);
	});

	it("knows the subagent-transcript record type", () => {
		// Found in the wild by the unknown-record counter, not anticipated.
		const parsed = parseClaudeTranscript(
			jsonl({ type: "agent-setting", agentSetting: "general-purpose", sessionId: "sess-1" }),
			"/t.jsonl",
		);
		expect(parsed.stats.unknownRecords).toBe(0);
		expect(parsed.fidelity.level).toBe("full");
	});

	it("flags an unmapped record type instead of silently skipping it", () => {
		const parsed = parseClaudeTranscript(jsonl({ type: "brand-new-thing", sessionId: "sess-1" }), "/t.jsonl");
		expect(parsed.stats.unknownRecords).toBe(1);
		expect(parsed.sessionEvents).toHaveLength(1);
		expect(parsed.fidelity.level).toBe("partial");
	});

	it("treats a truncated final line as a live write, not corruption", () => {
		const body = `${jsonl(claudeUser)}{"type":"assist`;
		const parsed = parseClaudeTranscript(body, "/t.jsonl");
		expect(parsed.stats.malformedLines).toBe(0);
		expect(parsed.fidelity.warnings.join(" ")).toContain("truncated");
		expect(ev(parsed)).toHaveLength(1);
	});

	it("counts a broken mid-file line as malformed", () => {
		const body = `{"type":"user","broken\n${jsonl(claudeUser)}`;
		const parsed = parseClaudeTranscript(body, "/t.jsonl");
		expect(parsed.stats.malformedLines).toBe(1);
	});

	it("marks a sidechain record so a subagent branch stays distinguishable", () => {
		const parsed = parseClaudeTranscript(jsonl({ ...claudeUser, isSidechain: true }), "/t.jsonl");
		expect(ev(parsed)[0].sidechain).toBe(true);
	});

	it("omits raw records unless asked", () => {
		expect(ev(parseClaudeTranscript(jsonl(claudeUser), "/t.jsonl"))[0].raw).toBeUndefined();
		expect(ev(parseClaudeTranscript(jsonl(claudeUser), "/t.jsonl", { includeRaw: true }))[0].raw).toMatchObject({
			uuid: "u1",
		});
	});
});

const codexMeta = {
	type: "session_meta",
	timestamp: "2026-08-17T09:00:00.000Z",
	payload: { id: "roll-1", cwd: "/w", cli_version: "1.2.3" },
};

const codexTurnContext = {
	type: "turn_context",
	timestamp: "2026-08-17T09:00:01.000Z",
	payload: { model: "gpt-5-codex", cwd: "/w" },
};

const codexUserItem = {
	type: "response_item",
	timestamp: "2026-08-17T09:00:02.000Z",
	payload: { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "do the thing" }] },
};

const codexAssistantItem = {
	type: "response_item",
	timestamp: "2026-08-17T09:00:03.000Z",
	payload: { type: "message", role: "assistant", id: "m2", content: [{ type: "output_text", text: "done" }] },
};

const codexCall = {
	type: "response_item",
	timestamp: "2026-08-17T09:00:04.000Z",
	payload: { type: "function_call", id: "fc1", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "call_1" },
};

const codexCallOutput = {
	type: "response_item",
	timestamp: "2026-08-17T09:00:05.000Z",
	payload: { type: "function_call_output", id: "fco1", call_id: "call_1", output: "a.ts\n" },
};

describe("parseCodexTranscript", () => {
	it("reads the session id and cwd out of the header line, not the filename", () => {
		const parsed = parseCodexTranscript(jsonl(codexMeta, codexTurnContext, codexUserItem), "/rollout-x.jsonl");
		expect(parsed.sessionId).toBe("roll-1");
		expect(parsed.cwd).toBe("/w");
		expect(parsed.model).toBe("gpt-5-codex");
	});

	it("maps messages and tool calls off the response_item stream", () => {
		const parsed = parseCodexTranscript(jsonl(codexUserItem, codexAssistantItem, codexCall, codexCallOutput), "/r.jsonl");
		expect(ev(parsed).map((e) => e.kind)).toEqual(["message", "message", "tool-call", "tool-result"]);
		expect(ev(parsed)[2].tool).toMatchObject({ callId: "call_1", name: "exec_command" });
		expect(ev(parsed)[3].tool?.output).toBe("a.ts\n");
	});

	it("skips the UI events that restate a response_item, counting them as duplicates", () => {
		const parsed = parseCodexTranscript(
			jsonl(codexUserItem, { type: "event_msg", payload: { type: "user_message", message: "do the thing" } }),
			"/r.jsonl",
		);
		expect(parsed.stats.messages).toBe(1);
		expect(parsed.stats.duplicateRecords).toBe(1);
	});

	it("sums per-turn token usage, never the cumulative total", () => {
		const tokenCount = {
			type: "event_msg",
			payload: {
				type: "token_count",
				info: {
					total_token_usage: { input_tokens: 900, output_tokens: 90, cached_input_tokens: 9, cache_write_input_tokens: 0 },
					last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 1, cache_write_input_tokens: 0 },
				},
			},
		};
		const parsed = parseCodexTranscript(jsonl(tokenCount, tokenCount), "/r.jsonl");
		expect(parsed.stats.usage).toEqual({ input: 200, output: 20, cacheRead: 2, cacheWrite: 0 });
	});

	it("warns that reasoning is only a summary", () => {
		const reasoning = {
			type: "response_item",
			payload: { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "**Planning**" }] },
		};
		const parsed = parseCodexTranscript(jsonl(reasoning), "/r.jsonl");
		expect(ev(parsed)[0]).toMatchObject({ kind: "thinking", text: "**Planning**" });
		expect(parsed.fidelity.warnings.join(" ")).toContain("encrypted");
	});

	it("keeps an unmapped response item and reports it", () => {
		const parsed = parseCodexTranscript(
			jsonl({ type: "response_item", payload: { type: "brand_new_item", id: "x1" } }),
			"/r.jsonl",
		);
		expect(parsed.stats.unknownRecords).toBe(1);
		expect(parsed.sessionEvents[0].meta).toMatchObject({ itemType: "brand_new_item" });
	});
});

describe("detectConversationSource", () => {
	it("recognizes a codex rollout by its header line", () => {
		expect(detectConversationSource(jsonl(codexMeta))).toBe("codex");
	});

	it("recognizes a claude transcript by its sessionId-bearing records", () => {
		expect(detectConversationSource(jsonl(claudeUser))).toBe("claude");
	});

	it("returns null for something that is not a transcript", () => {
		expect(detectConversationSource(jsonl({ hello: "world" }))).toBeNull();
	});
});

describe("scanJsonl", () => {
	it("ignores blank lines and rejects non-object records", () => {
		const scan = scanJsonl('{"a":1}\n\n[1,2]\n"text"\n');
		expect(scan.records).toEqual([{ a: 1 }]);
		expect(scan.malformedLines).toBe(2);
		expect(scan.truncatedTail).toBe(false);
	});
});
