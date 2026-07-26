import { describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../../shared/agent-message-envelope";

describe("wrapAgentMessage", () => {
	it("wraps the text with the sender seq and a reply command", () => {
		const out = wrapAgentMessage("do the thing", { taskId: "t-1", seq: 1310, title: "Fix the parser" });
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
		const out = wrapAgentMessage("line 1\n\nline <2>", { taskId: "t-1", seq: 7 });
		expect(out).toContain("<message>\nline 1\n\nline <2>\n</message>");
		expect(out).not.toContain("<from-title>");
	});

	it("escapes markup in the sender title", () => {
		const out = wrapAgentMessage("hi", { taskId: "t-1", seq: 9, title: "Fix <div> & span" });
		expect(out).toContain("<from-title>Fix &lt;div&gt; &amp; span</from-title>");
	});
});
