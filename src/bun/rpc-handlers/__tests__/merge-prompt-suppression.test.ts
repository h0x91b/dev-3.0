import { describe, it, expect } from "vitest";
import type { MergeCompletionPromptState } from "../../../shared/types";
import {
	shouldSuppressMergePrompt,
	MERGE_PROMPT_FALLBACK_SUPPRESS_MS,
	type MergeCompletionFingerprint,
} from "../merge-prompt-suppression";

const HEAD = "v1:fix/dev3-merge-popup:2b89460fd5a6d153c7f4e18066f62edf6e8c588e";
const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const preciseFp: MergeCompletionFingerprint = { fingerprint: HEAD, precise: true };

function state(overrides: Partial<MergeCompletionPromptState>): MergeCompletionPromptState {
	return {
		fingerprint: HEAD,
		promptedAt: new Date(NOW).toISOString(),
		dismissedAt: null,
		precise: true,
		...overrides,
	};
}

describe("shouldSuppressMergePrompt", () => {
	it("never suppresses when there is no prior prompt state", () => {
		expect(shouldSuppressMergePrompt(null, preciseFp, NOW)).toBe(false);
	});

	it("never suppresses when the stored fingerprint is for a different head", () => {
		const other = state({ fingerprint: "v1:other:deadbeef" });
		expect(shouldSuppressMergePrompt(other, preciseFp, NOW)).toBe(false);
	});

	it("permanently suppresses a precise head the user explicitly dismissed", () => {
		const dismissed = state({
			promptedAt: new Date(NOW - 10 * MERGE_PROMPT_FALLBACK_SUPPRESS_MS).toISOString(),
			dismissedAt: new Date(NOW - 10 * MERGE_PROMPT_FALLBACK_SUPPRESS_MS).toISOString(),
		});
		// Even far past the fallback window, a dismissed precise head stays muted.
		expect(shouldSuppressMergePrompt(dismissed, preciseFp, NOW)).toBe(true);
	});

	// ── Option B: an unanswered prompt must keep coming back ──────────────────

	it("does NOT suppress an unanswered prompt reserved seconds ago (dismissedAt null)", () => {
		// Reproduces the lost-popup bug: the prompt was reserved (promptedAt set)
		// but the user never answered (dismissedAt null). Once the task leaves and
		// re-enters an eligible status, the next poll must re-offer completion —
		// the 1h fallback window must NOT mute an unanswered prompt.
		const unanswered = state({ promptedAt: new Date(NOW - 30_000).toISOString() });
		expect(shouldSuppressMergePrompt(unanswered, preciseFp, NOW)).toBe(false);
	});

	it("does NOT suppress an unanswered non-precise prompt either", () => {
		const fallbackFp: MergeCompletionFingerprint = { fingerprint: "fallback:branch", precise: false };
		const unanswered = state({
			fingerprint: "fallback:branch",
			precise: false,
			promptedAt: new Date(NOW - 30_000).toISOString(),
		});
		expect(shouldSuppressMergePrompt(unanswered, fallbackFp, NOW)).toBe(false);
	});

	it("time-suppresses a recently dismissed non-precise prompt (can't prove same head)", () => {
		const fallbackFp: MergeCompletionFingerprint = { fingerprint: "fallback:branch", precise: false };
		const dismissed = state({
			fingerprint: "fallback:branch",
			precise: false,
			promptedAt: new Date(NOW - 60_000).toISOString(),
			dismissedAt: new Date(NOW - 60_000).toISOString(),
		});
		expect(shouldSuppressMergePrompt(dismissed, fallbackFp, NOW)).toBe(true);
	});

	it("stops suppressing a dismissed non-precise prompt once the fallback window passes", () => {
		const fallbackFp: MergeCompletionFingerprint = { fingerprint: "fallback:branch", precise: false };
		const dismissed = state({
			fingerprint: "fallback:branch",
			precise: false,
			promptedAt: new Date(NOW - 2 * MERGE_PROMPT_FALLBACK_SUPPRESS_MS).toISOString(),
			dismissedAt: new Date(NOW - 2 * MERGE_PROMPT_FALLBACK_SUPPRESS_MS).toISOString(),
		});
		expect(shouldSuppressMergePrompt(dismissed, fallbackFp, NOW)).toBe(false);
	});
});
