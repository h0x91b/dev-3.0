/**
 * The rules that separate a human's terminal prompt from dev3's own writing,
 * and the receipts that make the separation provable rather than guessed.
 *
 * The cases that carry the weight are the negative ones: a peer's message, a
 * held burst, and the task brief handed over as a launch argument all reach the
 * prompt-submit hook looking exactly like someone typing. Each of them has its
 * own case here, and each fails the moment the receipt is dropped or matched
 * loosely.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../../shared/agent-message-envelope";
import { AGENT_MESSAGE_BURST_SEPARATOR } from "../../shared/agent-message-envelope";
import {
	TERMINAL_PROMPT_PREVIEW_MAX_CHARS,
	isDev3EnvelopeText,
	promptSubmissionKey,
	submissionMatchesTypedText,
	terminalPromptPreview,
} from "../../shared/agent-terminal-prompt";
import {
	TYPED_PROMPT_CLAIM_LIMIT,
	TYPED_PROMPT_CLAIM_TTL_MS,
	claimDev3TypedPrompt,
	noteDev3TypedPrompt,
	resetTypedPromptClaims,
	typedPromptClaimCount,
} from "../agent-typed-prompt-claims";

const TASK = "task-1";

beforeEach(() => {
	resetTypedPromptClaims();
});

describe("the envelope test", () => {
	it("recognises what wrapAgentMessage produces, even as the first member of a burst, but not a later mention", () => {
		const wrapped = wrapAgentMessage("hi", { taskId: "t-1", seq: 7, title: "Peer" }, "proj-1", "a subject");
		expect(isDev3EnvelopeText(wrapped), "single envelope").toBe(true);
		const first = wrapAgentMessage("one", { taskId: "t-1", seq: 7 }, "proj-1", "first");
		const second = wrapAgentMessage("two", { taskId: "t-2", seq: 8 }, "proj-1", "second");
		expect(isDev3EnvelopeText(`${first}${AGENT_MESSAGE_BURST_SEPARATOR}${second}`), "burst").toBe(true);
		expect(isDev3EnvelopeText("why does <dev3-ai-message> show up in my terminal?"), "human mention").toBe(false);
	});
});

describe("matching what dev3 typed", () => {
	it("matches through line endings, a protocol-extended brief, or one burst member, never a short fragment", () => {
		expect(submissionMatchesTypedText("hello there\r\nsecond line\n\n", "hello there\nsecond line"), "line endings").toBe(true);
		expect(submissionMatchesTypedText("Fix the auth race\n\n# dev3 protocol\n...", "Fix the auth race"), "launch brief").toBe(true);
		const submitted = `<dev3-ai-message>a</dev3-ai-message>\n\nthe second peer's whole body here\n\n<dev3-board>…</dev3-board>`;
		expect(submissionMatchesTypedText(submitted, "the second peer's whole body here"), "burst member").toBe(true);
		// "ok" as a hand-off must not swallow every prompt containing the word.
		expect(submissionMatchesTypedText("looks ok to me, ship it", "ok"), "short fragment").toBe(false);
	});
});

describe("the receipts", () => {
	it("keeps one receipt per delivery and consumes each once", () => {
		noteDev3TypedPrompt(TASK, "run the migration now please");
		noteDev3TypedPrompt(TASK, "run the migration now please");
		expect(claimDev3TypedPrompt(TASK, "run the migration now please")).toBe(true);
		expect(claimDev3TypedPrompt(TASK, "run the migration now please")).toBe(true);
		expect(claimDev3TypedPrompt(TASK, "run the migration now please")).toBe(false);
	});

	it("never covers another task's pane, and expires so it cannot swallow a prompt hours later", () => {
		const t0 = 1_000_000;
		noteDev3TypedPrompt(TASK, "a message with enough length", t0);
		expect(claimDev3TypedPrompt("task-2", "a message with enough length", t0), "other task").toBe(false);
		expect(claimDev3TypedPrompt(TASK, "a message with enough length", t0 + TYPED_PROMPT_CLAIM_TTL_MS + 1), "expired").toBe(false);
	});

	it("drops the oldest receipts rather than growing without bound, and leaves none for an empty delivery", () => {
		noteDev3TypedPrompt(TASK, "   \n  ");
		expect(typedPromptClaimCount(TASK), "empty delivery").toBe(0);
		for (let i = 0; i < TYPED_PROMPT_CLAIM_LIMIT + 10; i += 1) {
			noteDev3TypedPrompt(TASK, `delivery number ${i} of many`);
		}
		expect(typedPromptClaimCount(TASK)).toBe(TYPED_PROMPT_CLAIM_LIMIT);
		expect(claimDev3TypedPrompt(TASK, "delivery number 0 of many")).toBe(false);
	});
});

describe("what gets stored", () => {
	it("clamps a long prompt, drops its tail entirely, and collapses a pasted block onto one line", () => {
		const preview = terminalPromptPreview(`${"x".repeat(400)}SECRET-TAIL`);
		expect(preview.length).toBeLessThanOrEqual(TERMINAL_PROMPT_PREVIEW_MAX_CHARS);
		expect(preview).not.toContain("SECRET-TAIL");
		expect(terminalPromptPreview("first\n\n   second\tthird")).toBe("first second third");
	});
});

describe("submission identity", () => {
	it("separates two harnesses that reuse an id, and is null with nothing to identify by", () => {
		expect(promptSubmissionKey("claude", "s", "p")).not.toBe(promptSubmissionKey("codex", "s", "p"));
		expect(promptSubmissionKey("claude", null, undefined)).toBeNull();
	});
});
