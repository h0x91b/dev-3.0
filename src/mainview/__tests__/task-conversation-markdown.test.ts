import { clipMarkdown, TASK_CONVERSATION_TEXT_LIMIT } from "../../shared/task-conversation-model";

/**
 * The folded half of a message is Markdown that has to stand on its own. Cutting
 * at a character index is what breaks it, so these are the shapes that break.
 */
describe("clipMarkdown", () => {
	it("leaves a short message exactly as written", () => {
		const text = "**hi**\n\n- one\n- two";
		expect(clipMarkdown(text)).toEqual({ text, clipped: false });
	});

	it("cuts on a block boundary, not mid-sentence", () => {
		const block = `${"word ".repeat(300)}\n\n`; // 1500 chars
		const tail = `second paragraph that must not be halved ${"more ".repeat(200)}`;
		const text = `${block}${tail}`;
		const { text: cut, clipped } = clipMarkdown(text);
		expect(clipped).toBe(true);
		expect(cut.endsWith("…")).toBe(true);
		expect(cut).not.toContain("second paragraph that must not be halved");
		expect(cut.trim().startsWith("word")).toBe(true);
	});

	it("closes a fence it had to cut through", () => {
		const text = `\`\`\`ts\n${"const x = 1;\n".repeat(200)}\`\`\`\n\ntail`;
		const { text: cut } = clipMarkdown(text);
		const fences = (cut.match(/^\s*```/gm) ?? []).length;
		expect(fences % 2).toBe(0);
	});

	it("never carries more than the budget plus its own marker", () => {
		const text = "x".repeat(TASK_CONVERSATION_TEXT_LIMIT * 3);
		const { text: cut } = clipMarkdown(text);
		expect(cut.length).toBeLessThanOrEqual(TASK_CONVERSATION_TEXT_LIMIT + 4);
	});
});
