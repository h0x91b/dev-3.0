import { afterEach, describe, expect, it } from "vitest";
import {
	claimDev3TypedPrompt,
	noteDev3TypedPrompt,
	resetTypedPromptClaims,
	retractDev3TypedPrompt,
	typedPromptClaimCount,
} from "../agent-typed-prompt-claims";

const TASK = "task-1";
const INNER = "Read it in full and act on each message inside the batch file: /task/messages/burst-1.md";
const POINTER = `<dev3-ai-message>\n3 held messages. ${INNER}\n</dev3-ai-message>`;

afterEach(() => resetTypedPromptClaims());

describe("retractDev3TypedPrompt — taking back a receipt for text never typed", () => {
	it("removes exactly that receipt, even when a newer one is contained in it", () => {
		noteDev3TypedPrompt(TASK, POINTER);
		// Noted after the pointer and contained in it: a containment match would spend this one.
		noteDev3TypedPrompt(TASK, INNER);

		expect(retractDev3TypedPrompt(TASK, POINTER)).toBe(true);

		expect(typedPromptClaimCount(TASK)).toBe(1);
		expect(claimDev3TypedPrompt(TASK, INNER)).toBe(true);
		expect(claimDev3TypedPrompt(TASK, POINTER)).toBe(false);
	});

	it("removes one receipt per call when the same text was noted twice", () => {
		noteDev3TypedPrompt(TASK, POINTER);
		noteDev3TypedPrompt(TASK, POINTER);

		expect(retractDev3TypedPrompt(TASK, POINTER)).toBe(true);
		expect(typedPromptClaimCount(TASK)).toBe(1);
	});

	it("answers false and changes nothing when no receipt matches exactly", () => {
		noteDev3TypedPrompt(TASK, "held messages");

		expect(retractDev3TypedPrompt(TASK, POINTER)).toBe(false);
		expect(typedPromptClaimCount(TASK)).toBe(1);
	});
});
