import { describe, expect, it } from "vitest";
import { agentReplyCommand, agentReplyRef, wrapAgentMessage } from "../../shared/agent-message-envelope";

const PROJECT_A = "aaaaaaaa-1111-2222-3333-444455556666";
const PROJECT_B = "bbbbbbbb-1111-2222-3333-444455556666";

describe("wrapAgentMessage", () => {
	it("wraps the text with the sender seq and a reply command", () => {
		const out = wrapAgentMessage(
			"do the thing",
			{ taskId: "t-1", seq: 1310, title: "Fix the parser", projectId: PROJECT_A },
			PROJECT_A,
		);
		expect(out).toBe(
			[
				"<dev3-ai-message>",
				"<from-task>seq:1310</from-task>",
				"<from-title>Fix the parser</from-title>",
				'<reply-with>dev3 message --task seq:1310 "your reply"</reply-with>',
				"<message>",
				"do the thing",
				"</message>",
				"</dev3-ai-message>",
			].join("\n"),
		);
	});

	it("keeps a multi-line body verbatim", () => {
		const out = wrapAgentMessage("line 1\n\nline <2>", { taskId: "t-1", seq: 7 }, PROJECT_A);
		expect(out).toContain("<message>\nline 1\n\nline <2>\n</message>");
		expect(out).not.toContain("<from-title>");
	});

	it("escapes markup in the sender title", () => {
		const out = wrapAgentMessage("hi", { taskId: "t-1", seq: 9, title: "Fix <div> & span" }, PROJECT_A);
		expect(out).toContain("<from-title>Fix &lt;div&gt; &amp; span</from-title>");
	});

	it("addresses a variant sender by task id — its seq is shared with its siblings", () => {
		const out = wrapAgentMessage(
			"hi",
			{ taskId: "7a9e61f4-1111-2222-3333-444455556666", seq: 1575, variantIndex: 1 },
			PROJECT_A,
		);
		expect(out).toContain("<from-task>7a9e61f4-1111-2222-3333-444455556666</from-task>");
		expect(out).toContain('<reply-with>dev3 message --task 7a9e61f4-1111-2222-3333-444455556666 "your reply"</reply-with>');
		expect(out).not.toContain("seq:1575");
	});

	it("keeps the seq address when the sender has no variant", () => {
		const out = wrapAgentMessage("hi", { taskId: "t-1", seq: 1575, variantIndex: null }, PROJECT_A);
		expect(out).toContain('<reply-with>dev3 message --task seq:1575 "your reply"</reply-with>');
	});

	it("scopes the reply command when the sender sits on another board", () => {
		const out = wrapAgentMessage("hi", { taskId: "t-1", seq: 1623, projectId: PROJECT_B }, PROJECT_A);
		expect(out).toContain('<reply-with>dev3 message --task seq:1623 --project bbbbbbbb "your reply"</reply-with>');
	});
});

describe("agentReplyRef", () => {
	it("prefers the seq handle, falls back to the id for a variant", () => {
		expect(agentReplyRef({ id: "abc", seq: 42, variantIndex: null })).toBe("seq:42");
		expect(agentReplyRef({ id: "abc", seq: 42 })).toBe("seq:42");
		expect(agentReplyRef({ id: "abc", seq: 42, variantIndex: 0 })).toBe("abc");
		expect(agentReplyRef({ id: "abc", seq: 42, variantIndex: 2 })).toBe("abc");
	});
});

describe("agentReplyCommand", () => {
	const target = { id: "t-1", seq: 42, projectId: PROJECT_B };

	it("omits --project inside one project", () => {
		expect(agentReplyCommand({ target, fromProjectId: PROJECT_B, quoted: "your message" })).toBe(
			'dev3 message --task seq:42 "your message"',
		);
	});

	it("adds an 8-char --project prefix across projects", () => {
		expect(agentReplyCommand({ target, fromProjectId: PROJECT_A, quoted: "your message" })).toBe(
			'dev3 message --task seq:42 --project bbbbbbbb "your message"',
		);
	});

	it("stays bare when the target project is unknown", () => {
		expect(
			agentReplyCommand({ target: { id: "t-1", seq: 42 }, fromProjectId: PROJECT_A, quoted: "your reply" }),
		).toBe('dev3 message --task seq:42 "your reply"');
	});

	it("addresses a variant target by id and still scopes it", () => {
		expect(
			agentReplyCommand({
				target: { id: "t-9", seq: 7, variantIndex: 2, projectId: PROJECT_B },
				fromProjectId: PROJECT_A,
				quoted: "your reply",
			}),
		).toBe('dev3 message --task t-9 --project bbbbbbbb "your reply"');
	});
});
