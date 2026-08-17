import { describe, expect, it } from "vitest";
import { parseClaudeTranscript, parseCodexTranscript } from "../../shared/conversation-parsers";
import { normalizeToolCall, describeToolCall, filesTouched } from "../../shared/conversation-tools";
import { renderHandoff } from "../../shared/conversation-render";
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
	});

	it("reads Codex arguments out of their JSON string form", () => {
		expect(normalizeToolCall("codex", "exec_command", '{"cmd":"pwd"}').command).toBe("pwd");
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

	it("recognizes an MCP tool by its namespace, without a lookup table", () => {
		const call = normalizeToolCall("claude", "mcp__playwright__browser_navigate", { url: "http://x" });
		expect(call.op).toBe("mcp.call");
		expect(call.extra).toMatchObject({ server: "playwright", tool: "browser_navigate" });
	});

	it("keeps an unknown tool's name and arguments instead of discarding them", () => {
		const call = normalizeToolCall("codex", "brand_new_tool", '{"a":1}');
		expect(call.op).toBe("unknown");
		expect(call.nativeName).toBe("brand_new_tool");
		expect(call.extra).toMatchObject({ args: { a: 1 } });
	});

	it("keeps a code-mode program as a body rather than pretending it is JSON", () => {
		const call = normalizeToolCall("codex", "exec", 'const r = await tools.exec_command({"cmd":"ls"});');
		expect(call.op).toBe("code.exec");
		expect(call.body).toContain("tools.exec_command");
	});

	it("describes a call the same way whichever agent made it", () => {
		const claude = describeToolCall(normalizeToolCall("claude", "Bash", { command: "ls" }));
		const codex = describeToolCall(normalizeToolCall("codex", "exec_command", '{"cmd":"ls"}'));
		expect(claude).toBe("ran: ls");
		expect(codex).toBe("ran: ls");
	});

	it("collects written and edited files, ignoring reads", () => {
		const calls = [
			normalizeToolCall("claude", "Read", { file_path: "/w/read.ts" }),
			normalizeToolCall("claude", "Write", { file_path: "/w/new.ts", content: "x" }),
			normalizeToolCall("claude", "Edit", { file_path: "/w/new.ts", new_string: "y" }),
		];
		expect(filesTouched(calls)).toEqual(["/w/new.ts"]);
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

	it("puts events preceding the first prompt into a preamble turn", () => {
		const parsed = parseClaudeTranscript(jsonl(assistantReply, userRecord("later", "u1")), "/t.jsonl");
		expect(parsed.turns[0].trigger).toBe("preamble");
		expect(parsed.turns[1].trigger).toBe("user");
	});

	it("canonicalizes tool calls inside the turns", () => {
		expect(toolCallsOf(conversation())).toMatchObject([{ op: "shell.run", command: "ls" }]);
	});
});

describe("renderHandoff", () => {
	it("frames the text as a takeover and names the source agent", () => {
		const text = renderHandoff(conversation(), { target: "codex" });
		expect(text).toContain("taking over work that ran in Claude Code");
		expect(text).toContain("You did not perform any of the");
	});

	it("carries the user's prompts and the agent's replies verbatim", () => {
		const text = renderHandoff(conversation());
		expect(text).toContain("first ask");
		expect(text).toContain("second ask");
		expect(text).toContain("two files");
	});

	it("describes actions canonically and includes the paired output", () => {
		const text = renderHandoff(conversation());
		expect(text).toContain("ran: ls");
		expect(text).toContain("a.ts\nb.ts");
	});

	it("omits reasoning by default and includes it on request", () => {
		expect(renderHandoff(conversation())).not.toContain("secret plan");
		expect(renderHandoff(conversation(), { includeThinking: true })).toContain("secret plan");
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
	});

	it("drops tool output entirely at a zero budget, keeping the action", () => {
		const text = renderHandoff(conversation(), { toolOutputLimit: 0 });
		expect(text).toContain("ran: ls");
		expect(text).not.toContain("a.ts\nb.ts");
	});

	it("keeps only the last N turns and says how many it dropped", () => {
		const text = renderHandoff(conversation(), { maxTurns: 1 });
		expect(text).toContain("second ask");
		expect(text).not.toContain("first ask");
		expect(text).toContain("turns are omitted");
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

	it("renders a Codex conversation with the same shape", () => {
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
	});

	it("passes the fidelity warnings through instead of hiding them", () => {
		const codex = parseCodexTranscript(
			jsonl({ type: "response_item", payload: { type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "plan" }] } }),
			"/r.jsonl",
		);
		expect(renderHandoff(codex)).toContain("encrypted");
	});
});
