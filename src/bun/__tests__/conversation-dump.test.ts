import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "../../shared/conversation-parsers";
import { COMPACTION_RECORD_TYPE, type ConversationEvent } from "../../shared/conversation-model";
import {
	DEFAULT_DUMP_BUDGET,
	projectConversationForDump,
	sessionRecordType,
	turnAssistantText,
	turnUserText,
} from "../../shared/conversation-dump";

function jsonl(...records: unknown[]): string {
	return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

const user = (text: string, uuid = "u1") => ({
	type: "user",
	uuid,
	sessionId: "s1",
	cwd: "/w",
	timestamp: "2026-08-17T10:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text }] },
});

const bigWrite = {
	type: "assistant",
	uuid: "a1",
	sessionId: "s1",
	timestamp: "2026-08-17T10:00:01.000Z",
	message: {
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "t1",
				name: "Write",
				input: { file_path: "/w/big.ts", content: "X".repeat(5000) },
			},
		],
		usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
};

const bigResult = {
	type: "user",
	uuid: "u2",
	sessionId: "s1",
	timestamp: "2026-08-17T10:00:02.000Z",
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Y".repeat(5000) }] },
};

const reply = {
	type: "assistant",
	uuid: "a2",
	sessionId: "s1",
	timestamp: "2026-08-17T10:00:03.000Z",
	message: { role: "assistant", content: [{ type: "text", text: "done writing" }] },
};

const attachment = (type: string, uuid: string) => ({
	type: "attachment",
	uuid,
	sessionId: "s1",
	timestamp: "2026-08-17T10:00:04.000Z",
	attachment: { type },
});

const parsed = () => parseClaudeTranscript(jsonl(user("write it"), bigWrite, bigResult, reply), "/t.jsonl");

describe("projectConversationForDump", () => {
	it("truncates tool output and file contents to the payload budget", () => {
		const dump = projectConversationForDump(parsed(), { action: 2000, payload: 100 });
		const events = dump.turns[0].events;
		const call = events.find((e) => e.kind === "tool-call");
		const result = events.find((e) => e.kind === "tool-result");

		expect((call?.tool?.input as { content: string }).content).toContain("…[+4900 chars]");
		expect(result?.tool?.output).toContain("…[+4900 chars]");
		expect(dump.dumpPolicy.truncatedValues).toBe(2);
		expect(dump.dumpPolicy.truncatedChars).toBe(9800);
	});

	it("keeps a path the payload budget cut out of the input", () => {
		// An absolute worktree path alone is ~92 chars, so a tight payload budget eats
		// it; the canonical copy is what keeps the file identifiable.
		const path = `/w/${"deep/".repeat(20)}big.ts`;
		const source = parseClaudeTranscript(
			jsonl(user("write it"), {
				...bigWrite,
				message: {
					...bigWrite.message,
					content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: path, content: "X" } }],
				},
			}),
			"/t.jsonl",
		);
		const call = projectConversationForDump(source, { action: 2000, payload: 10 }).turns[0].events.find(
			(e) => e.kind === "tool-call",
		);
		expect(call?.tool?.canonical?.path).toBe(path);
	});

	it("omits the canonical body that duplicates the native input", () => {
		const dump = projectConversationForDump(parsed());
		const call = dump.turns[0].events.find((e) => e.kind === "tool-call");
		expect(call?.tool?.canonical?.body).toBeUndefined();
		expect(dump.dumpPolicy.omittedDuplicates).toContain("events[].tool.canonical.body");
	});

	it("drops per-event usage but keeps the turn and session totals", () => {
		const dump = projectConversationForDump(parsed());
		expect(dump.turns[0].events.every((e) => e.usage === undefined)).toBe(true);
		expect(dump.turns[0].usage.output).toBe(10);
		expect(dump.stats.usage.output).toBe(10);
	});

	it("drops assistantText, which a reader derives instead", () => {
		const dump = projectConversationForDump(parsed());
		expect((dump.turns[0] as { assistantText?: string }).assistantText).toBeUndefined();
		expect(turnAssistantText(dump.turns[0])).toBe("done writing");
	});

	it("discards environment and plumbing records entirely", () => {
		const source = parseClaudeTranscript(
			jsonl(
				user("hi"),
				attachment("hook_success", "x1"),
				attachment("hook_success", "x2"),
				attachment("output_style", "x3"),
			),
			"/t.jsonl",
		);
		const dump = projectConversationForDump(source);

		expect(dump.notices).toHaveLength(0);
		expect(dump.dumpPolicy.discardedSessionEvents).toBe(3);
	});

	it("keeps the session records that change a takeover decision", () => {
		const source = parseClaudeTranscript(
			jsonl(
				user("hi"),
				attachment("hook_success", "x1"),
				// A hook failure is an environment defect, not a fact about the work.
				attachment("hook_non_blocking_error", "x2"),
				// The user edited a file outside the agent — the one record that transfers.
				attachment("edited_text_file", "x3"),
			),
			"/t.jsonl",
		);
		const dump = projectConversationForDump(source);

		expect(dump.notices.map((e: ConversationEvent) => sessionRecordType(e))).toEqual(["edited_text_file"]);
	});

	it("records the budget it applied, so fidelity is never implied", () => {
		const dump = projectConversationForDump(parsed());
		expect(dump.dumpPolicy.budget).toEqual(DEFAULT_DUMP_BUDGET);
	});

	it("leaves message text alone at any budget", () => {
		const long = "П".repeat(5000);
		const dump = projectConversationForDump(parseClaudeTranscript(jsonl(user(long)), "/t.jsonl"), {
			action: 10,
			payload: 10,
		});
		expect(turnUserText(dump.turns[0])).toBe(long);
		expect(dump.turns[0].events[0].text).toBe(long);
	});

	it("drops userText, which a reader derives from the turn's own events", () => {
		const dump = projectConversationForDump(parsed());
		expect((dump.turns[0] as { userText?: string }).userText).toBeUndefined();
		expect(turnUserText(dump.turns[0])).toBe("write it");
		expect(dump.dumpPolicy.omittedDuplicates).toContain("turns[].userText");
	});

	it("omits a canonical path the native input already carries", () => {
		const dump = projectConversationForDump(parsed());
		const call = dump.turns[0].events.find((e) => e.kind === "tool-call");
		expect(call?.tool?.canonical?.path).toBeUndefined();
		expect((call?.tool?.input as { file_path: string }).file_path).toBe("/w/big.ts");
	});

	it("keeps a canonical command truncation cut out of the input", () => {
		// Over the payload budget, under the action budget.
		const long = `echo ${"z".repeat(1500)}`;
		const source = parseClaudeTranscript(
			jsonl(user("run it"), {
				type: "assistant",
				uuid: "a9",
				sessionId: "s1",
				timestamp: "2026-08-17T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: long } }],
				},
			}),
			"/t.jsonl",
		);
		const call = projectConversationForDump(source).turns[0].events.find((e) => e.kind === "tool-call");
		// The input was cut at the payload budget, so the canonical copy is the only
		// one that still holds the command up to the roomier action budget.
		expect((call?.tool?.input as { command: string }).command).toContain("…[+");
		expect(call?.tool?.canonical?.command).toBe(long);
	});

	it("collapses reasoning blocks whose body the transcript withheld", () => {
		const source = parseClaudeTranscript(
			jsonl(user("think"), {
				type: "assistant",
				uuid: "a8",
				sessionId: "s1",
				timestamp: "2026-08-17T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "", signature: "sig" },
						{ type: "thinking", thinking: "", signature: "sig" },
						{ type: "thinking", thinking: "kept" },
					],
				},
			}),
			"/t.jsonl",
		);
		const turn = projectConversationForDump(source).turns[0];
		expect(turn.redactedThinking).toBe(2);
		expect(turn.events.filter((e) => e.kind === "thinking").map((e) => e.text)).toEqual(["kept"]);
	});

	it("keeps a compaction with what it cost, and flags the summary that replaced the history", () => {
		const source = parseClaudeTranscript(
			jsonl(
				user("hi"),
				{
					type: "system",
					uuid: "c1",
					subtype: "compact_boundary",
					sessionId: "s1",
					timestamp: "2026-08-17T10:00:05.000Z",
					compactMetadata: { trigger: "manual", preTokens: 431273, postTokens: 23420, cumulativeDroppedTokens: 407853, durationMs: 205120 },
				},
				{
					type: "user",
					uuid: "c2",
					isCompactSummary: true,
					sessionId: "s1",
					timestamp: "2026-08-17T10:00:06.000Z",
					message: { role: "user", content: "This session is being continued…" },
				},
			),
			"/t.jsonl",
		);
		const dump = projectConversationForDump(source);

		expect(dump.notices.map((e: ConversationEvent) => sessionRecordType(e))).toEqual([COMPACTION_RECORD_TYPE]);
		expect(dump.notices[0].meta).toMatchObject({ trigger: "manual", tokensBefore: 431273, tokensAfter: 23420 });
		// The summary opens a turn like a prompt does, but it was written by the agent.
		const opener = dump.turns[1].events[0];
		expect(opener.meta).toMatchObject({ compactSummary: true });
	});

	it("truncates a file snippet carried in meta, not just tool payloads", () => {
		const source = parseClaudeTranscript(
			jsonl(user("hi"), {
				type: "attachment",
				uuid: "s9",
				sessionId: "s1",
				timestamp: "2026-08-17T10:00:04.000Z",
				attachment: { type: "edited_text_file", filename: "/w/a.ts", snippet: "Z".repeat(5000) },
			}),
			"/t.jsonl",
		);
		const dump = projectConversationForDump(source, { action: 2000, payload: 100 });
		expect(String(dump.notices[0].meta?.snippet)).toContain("…[+4900 chars]");
	});

	it("shrinks a real-shaped conversation substantially", () => {
		const source = parsed();
		const full = JSON.stringify(source).length;
		const projected = JSON.stringify(projectConversationForDump(source)).length;
		expect(projected).toBeLessThan(full / 2);
	});
});
