import { describe, expect, it } from "vitest";
import { parseClaudeTranscript, parseCodexTranscript } from "../../shared/conversation-parsers";
import { normalizeToolCall, describeToolCall, filesTouched } from "../../shared/conversation-tools";
import { HANDOFF_FILE_LIMIT, renderHandoff, renderHandoffFile, renderImportedDescription } from "../../shared/conversation-render";
import { toolCallsOf } from "../../shared/conversation-model";

function jsonl(...records: unknown[]): string {
	return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("normalizeToolCall", () => {
	it("maps the two agents' shell tools onto one operation", () => {
		const claude = normalizeToolCall("claude", "Bash", { command: "ls -la", description: "list" });
		const codex = normalizeToolCall("codex", "exec_command", '{"cmd":"ls -la","workdir":"/w"}');

		expect(claude).toMatchObject({ op: "shell.run", command: "ls -la", nativeName: "Bash" });
		expect(codex).toMatchObject({ op: "shell.run", command: "ls -la", path: "/w", nativeName: "exec_command" });
		// Described the same way whichever agent made it.
		expect(describeToolCall(claude)).toBe("ran: ls -la");
		expect(describeToolCall(codex)).toBe("ran: ls -la");
	});

	it("maps file operations to the same ops from either side", () => {
		expect(normalizeToolCall("claude", "Read", { file_path: "/w/a.ts" })).toMatchObject({
			op: "file.read",
			path: "/w/a.ts",
		});
		expect(normalizeToolCall("claude", "Edit", { file_path: "/w/a.ts", new_string: "x" })).toMatchObject({
			op: "file.edit",
			path: "/w/a.ts",
		});
		expect(normalizeToolCall("codex", "apply_patch", "*** Begin Patch").op).toBe("file.patch");
		// filesTouched collects writes and edits, ignoring reads.
		const calls = [
			normalizeToolCall("claude", "Read", { file_path: "/w/read.ts" }),
			normalizeToolCall("claude", "Write", { file_path: "/w/new.ts", content: "x" }),
			normalizeToolCall("claude", "Edit", { file_path: "/w/new.ts", new_string: "y" }),
		];
		expect(filesTouched(calls)).toEqual(["/w/new.ts"]);
	});

	it("recovers the paths Codex only names inside a patch body", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			"@@",
			"-old",
			"+new",
			"*** Add File: src/b.ts",
			"+hello",
			"*** End Patch",
		].join("\n");
		const call = normalizeToolCall("codex", "apply_patch", patch);

		expect(call.extra).toMatchObject({ paths: ["src/a.ts", "src/b.ts"] });
		expect(describeToolCall(call)).toBe("patched src/a.ts, src/b.ts");
		// Codex has no Write/Edit tool — without this its changed files look empty.
		expect(filesTouched([call])).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("classifies MCP by namespace, keeps code-mode as a body and unknown tools with their args", () => {
		const mcp = normalizeToolCall("claude", "mcp__playwright__browser_navigate", { url: "http://x" });
		expect(mcp.op).toBe("mcp.call");
		expect(mcp.extra).toMatchObject({ server: "playwright", tool: "browser_navigate" });

		const code = normalizeToolCall("codex", "exec", 'const r = await tools.exec_command({"cmd":"ls"});');
		expect(code.op).toBe("code.exec");
		expect(code.body).toContain("tools.exec_command");

		const unknown = normalizeToolCall("codex", "brand_new_tool", '{"a":1}');
		expect(unknown.op).toBe("unknown");
		expect(unknown.nativeName).toBe("brand_new_tool");
		expect(unknown.extra).toMatchObject({ args: { a: 1 } });
	});

});

const userRecord = (text: string, uuid: string) => ({
	type: "user",
	uuid,
	sessionId: "s1",
	cwd: "/w",
	gitBranch: "main",
	timestamp: "2026-08-17T10:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text }] },
});

const assistantWork = {
	type: "assistant",
	uuid: "a1",
	sessionId: "s1",
	timestamp: "2026-08-17T10:00:01.000Z",
	message: {
		role: "assistant",
		model: "claude-opus-5",
		content: [
			{ type: "thinking", thinking: "secret plan", signature: "sig" },
			{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
		],
	},
};

const toolResult = {
	type: "user",
	uuid: "u9",
	sessionId: "s1",
	timestamp: "2026-08-17T10:00:02.000Z",
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts" }] },
};

const assistantReply = {
	type: "assistant",
	uuid: "a2",
	sessionId: "s1",
	timestamp: "2026-08-17T10:00:03.000Z",
	message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "two files" }] },
};

const conversation = () =>
	parseClaudeTranscript(
		jsonl(userRecord("first ask", "u1"), assistantWork, toolResult, assistantReply, userRecord("second ask", "u2")),
		"/t.jsonl",
	);

describe("turn assembly", () => {
	it("opens a turn on each user prompt, and a tool result does not split one", () => {
		const parsed = conversation();
		expect(parsed.turns).toHaveLength(2);
		expect(parsed.turns[0]).toMatchObject({ trigger: "user", userText: "first ask", assistantText: "two files" });
		expect(parsed.turns[1].userText).toBe("second ask");
		expect(parsed.stats.turns).toBe(2);
		expect(toolCallsOf(parsed)).toMatchObject([{ op: "shell.run", command: "ls" }]);

		const withPreamble = parseClaudeTranscript(jsonl(assistantReply, userRecord("later", "u1")), "/t.jsonl");
		expect(withPreamble.turns.map((t) => t.trigger)).toEqual(["preamble", "user"]);
	});

	it("keeps the agent's bookkeeping out of the conversation layer", () => {
		const parsed = parseClaudeTranscript(
			jsonl(userRecord("hi", "u1"), { type: "attachment", uuid: "x", sessionId: "s1", attachment: { type: "hook_success" } }),
			"/t.jsonl",
		);
		expect(parsed.turns[0].events.every((e) => e.kind === "message")).toBe(true);
		expect(parsed.sessionEvents).toHaveLength(1);
		expect(parsed.stats.sessionEvents).toBe(1);
	});

});

describe("renderHandoff", () => {
	it("frames a takeover and carries prompts, replies, canonical actions and their output", () => {
		const text = renderHandoff(conversation(), { target: "codex" });
		expect(text).toContain("taking over work that ran in Claude Code");
		expect(text).toContain("You did not perform any of the");
		for (const part of ["first ask", "second ask", "two files", "ran: ls", "a.ts\nb.ts"]) {
			expect(text).toContain(part);
		}
	});

	it("omits reasoning unless asked, and keeps only the last N turns saying how many it dropped", () => {
		expect(renderHandoff(conversation())).not.toContain("secret plan");
		expect(renderHandoff(conversation(), { includeThinking: true })).toContain("secret plan");
		const text = renderHandoff(conversation(), { maxTurns: 1 });
		expect(text).toContain("second ask");
		expect(text).not.toContain("first ask");
		expect(text).toContain("turns are omitted");
	});

	it("truncates tool output to the requested budget", () => {
		const long = {
			...toolResult,
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(5000) }] },
		};
		const parsed = parseClaudeTranscript(jsonl(userRecord("go", "u1"), assistantWork, long), "/t.jsonl");
		const text = renderHandoff(parsed, { toolOutputLimit: 100 });
		expect(text).toContain("more characters cut");
		expect(text.includes("x".repeat(200))).toBe(false);

		// A zero budget drops the output entirely but keeps the action.
		const zero = renderHandoff(conversation(), { toolOutputLimit: 0 });
		expect(zero).toContain("ran: ls");
		expect(zero).not.toContain("a.ts\nb.ts");
	});

	it("lists the files the conversation changed", () => {
		const write = {
			type: "assistant",
			uuid: "a3",
			sessionId: "s1",
			timestamp: "2026-08-17T10:00:04.000Z",
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "/w/out.ts", content: "x" } }],
			},
		};
		const parsed = parseClaudeTranscript(jsonl(userRecord("write it", "u1"), write), "/t.jsonl");
		expect(renderHandoff(parsed)).toContain("/w/out.ts");
	});

	it("renders a Codex conversation with the same shape, fidelity warnings included", () => {
		const codex = parseCodexTranscript(
			jsonl(
				{ type: "session_meta", timestamp: "2026-08-17T09:00:00.000Z", payload: { id: "r1", cwd: "/w" } },
				{ type: "response_item", payload: { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "codex ask" }] } },
				{ type: "response_item", payload: { type: "function_call", id: "f1", call_id: "c1", name: "exec_command", arguments: '{"cmd":"pwd"}' } },
				{ type: "response_item", payload: { type: "function_call_output", id: "o1", call_id: "c1", output: "/w" } },
			),
			"/r.jsonl",
		);
		const text = renderHandoff(codex, { target: "claude" });
		expect(text).toContain("taking over work that ran in Codex CLI");
		expect(text).toContain("codex ask");
		expect(text).toContain("ran: pwd");

		// Fidelity warnings pass through instead of being hidden.
		const reasoning = parseCodexTranscript(
			jsonl({ type: "response_item", payload: { type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "plan" }] } }),
			"/r.jsonl",
		);
		expect(renderHandoff(reasoning)).toContain("encrypted");
	});
});

describe("renderImportedDescription", () => {
	function conversationWith(turns: number, promptLength = 40): string {
		const records: unknown[] = [{ type: "ai-title", aiTitle: "Imported", sessionId: "s" }];
		for (let i = 0; i < turns; i++) {
			records.push({
				type: "user",
				uuid: `u${i}`,
				sessionId: "s",
				cwd: "/w",
				gitBranch: "main",
				timestamp: "2026-08-20T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: `${i === 0 ? "FIRST" : "later"} ${"x".repeat(promptLength)}` }] },
			});
			records.push({
				type: "assistant",
				uuid: `a${i}`,
				parentUuid: `u${i}`,
				sessionId: "s",
				timestamp: "2026-08-20T10:01:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: `answer ${i} ${"y".repeat(promptLength)}` }] },
			});
		}
		return jsonl(...records);
	}

	it("leads with the user's first request, in full, before the context block", () => {
		const parsed = parseClaudeTranscript(conversationWith(3), "/t.jsonl");
		const text = renderImportedDescription(parsed);
		expect(text).toContain("## The request that started this");
		expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("## Context"));
		// A short conversation stays whole.
		expect(text).toContain("answer 0");
		expect(text).toContain("answer 2");
		expect(text).not.toMatch(/turns are omitted/);
	});

	it("stays under the cap and says how many turns it dropped", () => {
		const parsed = parseClaudeTranscript(conversationWith(400, 400), "/t.jsonl");
		const text = renderImportedDescription(parsed, { limit: 20_000 });
		expect(text.length).toBeLessThanOrEqual(20_000);
		expect(text).toMatch(/The first \d+ of \d+ turns are omitted/);
		// The point of the work survives the shrinking.
		expect(text).toContain("FIRST");
	});

	it("marks the cut, naming the source store, when even one turn does not fit", () => {
		const parsed = parseClaudeTranscript(conversationWith(2, 5_000), "/t.jsonl");
		const text = renderImportedDescription(parsed, { limit: 2_000 });
		expect(text.length).toBeLessThanOrEqual(2_000);
		expect(text).toContain("more characters cut");

		// The cut marker names the source agent's own store.
		const codex = parseCodexTranscript(
			jsonl(
				{ type: "session_meta", payload: { id: "s", cwd: "/w" } },
				{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(5_000) }] } },
			),
			"/t.jsonl",
		);
		expect(renderImportedDescription(codex, { limit: 1_000 })).toContain("Codex's own transcript");
	});

	describe("renderHandoffFile", () => {
		it("frames the file as a takeover and stamps the parser that wrote it", () => {
			const parsed = parseClaudeTranscript(conversationWith(3), "/t.jsonl");
			const text = renderHandoffFile(parsed);
			expect(text).toContain("You are taking over work that ran in Claude Code");
			expect(text).toContain("Retold from a claude transcript by dev3 (parser");
			expect(text).toContain("Fidelity:");
			expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("## Context"));
		});

		it("fits a huge conversation under the file budget and says what it dropped", () => {
			const parsed = parseClaudeTranscript(conversationWith(400, 2_000), "/t.jsonl");
			const text = renderHandoffFile(parsed);
			expect(text.length).toBeLessThanOrEqual(HANDOFF_FILE_LIMIT);
			expect(text).toMatch(/The first \d+ of \d+ turns are omitted/);
			expect(text).toContain("FIRST");
		});

		it("carries more of each tool's output than a task description does", () => {
			const records: unknown[] = [
				{ type: "ai-title", aiTitle: "T", sessionId: "s" },
				{
					type: "user", uuid: "u0", sessionId: "s", cwd: "/w", timestamp: "2026-08-20T10:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "run it" }] },
				},
				{
					type: "assistant", uuid: "a0", parentUuid: "u0", sessionId: "s", timestamp: "2026-08-20T10:00:01.000Z",
					message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] },
				},
				{
					type: "user", uuid: "r0", parentUuid: "a0", sessionId: "s", timestamp: "2026-08-20T10:00:02.000Z",
					message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "z".repeat(700) }] },
				},
			];
			const parsed = parseClaudeTranscript(jsonl(...records), "/t.jsonl");
			// 700 characters of output: over a description's 400-char cap, under the file's 800.
			expect(renderImportedDescription(parsed)).toContain("more characters cut]");
			expect(renderHandoffFile(parsed)).toContain("z".repeat(700));
		});
	});
});
