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
	it("keeps a file write's path, drops what it wrote and every derivable duplicate, and records its budget", () => {
		const source = parsed();
		const dump = projectConversationForDump(source);
		const turn = dump.turns[0];
		const call = turn.events.find((e) => e.kind === "tool-call");
		const result = turn.events.find((e) => e.kind === "tool-result");

		// The path is the fact worth keeping; the content and the "file updated"
		// confirmation are both re-derivable from the repository.
		expect(call?.tool?.canonical).toMatchObject({ op: "file.write", path: "/w/big.ts" });
		// Arguments are stored once, in the canonical form every renderer can read.
		expect(call?.tool?.input).toBeUndefined();
		expect(call?.tool?.canonical?.body).toBeUndefined();
		expect(result?.tool?.output).toBeUndefined();
		expect(dump.dumpPolicy.droppedToolInputs).toBe(1);
		expect(dump.dumpPolicy.droppedToolOutputs).toBe(1);
		expect(dump.dumpPolicy.omittedDuplicates).toEqual(expect.arrayContaining([
			"events[].tool.canonical.body",
			"events[].tool.input",
			"turns[].userText",
		]));

		// Per-event usage goes; turn and session totals stay.
		expect(turn.events.every((e) => e.usage === undefined)).toBe(true);
		expect(turn.usage.output).toBe(10);
		expect(dump.stats.usage.output).toBe(10);

		// userText / assistantText are derived by the reader instead.
		expect((turn as { userText?: string }).userText).toBeUndefined();
		expect((turn as { assistantText?: string }).assistantText).toBeUndefined();
		expect(turnUserText(turn)).toBe("write it");
		expect(turnAssistantText(turn)).toBe("done writing");

		// Fidelity is never implied, and the projection is substantially smaller.
		expect(dump.dumpPolicy.budget).toEqual(DEFAULT_DUMP_BUDGET);
		expect(JSON.stringify(dump).length).toBeLessThan(JSON.stringify(source).length / 2);
	});

	it("keeps a shell command and a long path whole under the action budget, and bounds what was printed", () => {
		const source = parseClaudeTranscript(
			jsonl(
				user("run it"),
				{
					type: "assistant",
					uuid: "a1",
					sessionId: "s1",
					timestamp: "2026-08-17T10:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun run lint" } }],
					},
				},
				bigResult,
			),
			"/t.jsonl",
		);
		const dump = projectConversationForDump(source, { action: 2000, payload: 100 });
		const events = dump.turns[0].events;

		expect(events.find((e) => e.kind === "tool-call")?.tool?.canonical?.command).toBe("bun run lint");
		expect(events.find((e) => e.kind === "tool-result")?.tool?.output).toContain("…[+4900 chars]");
		{
		// An absolute worktree path alone is ~92 chars, so the payload budget would eat it.
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
		}
	});

	it("keeps what a search looked for, and what an unmapped tool was given", () => {
		const source = parseClaudeTranscript(
			jsonl(user("look"), {
				type: "assistant",
				uuid: "a3",
				sessionId: "s1",
				timestamp: "2026-08-17T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "TOOL_POLICY", path: "src" } },
						{ type: "tool_use", id: "t3", name: "SomeFutureTool", input: { whatever: "keep me" } },
					],
				},
			}),
			"/t.jsonl",
		);
		const calls = projectConversationForDump(source).turns[0].events.filter((e) => e.kind === "tool-call");

		expect(calls[0].tool?.canonical).toMatchObject({ op: "search", body: "TOOL_POLICY", path: "src" });
		// Unmapped: nothing is known about which argument matters, so all of them stay.
		expect(calls[1].tool?.canonical).toMatchObject({ op: "unknown", extra: { args: { whatever: "keep me" } } });
	});

	it("discards environment and plumbing records, keeping only the ones that change a takeover decision", () => {
		const plumbing = projectConversationForDump(parseClaudeTranscript(
			jsonl(user("hi"), attachment("hook_success", "x1"), attachment("hook_success", "x2"), attachment("output_style", "x3")),
			"/t.jsonl",
		));
		expect(plumbing.notices).toHaveLength(0);
		expect(plumbing.dumpPolicy.discardedSessionEvents).toBe(3);

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

	it("leaves message text alone at any budget but truncates a file snippet carried in meta", () => {
		const long = "П".repeat(5000);
		const dump = projectConversationForDump(parseClaudeTranscript(jsonl(user(long)), "/t.jsonl"), {
			action: 10,
			payload: 10,
		});
		expect(turnUserText(dump.turns[0])).toBe(long);
		expect(dump.turns[0].events[0].text).toBe(long);
		{
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
		}
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

});
