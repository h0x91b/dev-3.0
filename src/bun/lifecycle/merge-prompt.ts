import type { MergeCompletionPromptState } from "../../shared/types";

// A reservation only mutes re-prompts for this window: if the user never
// answers (app restart, undelivered push), the prompt must come back instead
// of being lost forever.
export const MERGE_PROMPT_FALLBACK_SUPPRESS_MS = 60 * 60 * 1000;
export const MERGE_PROMPT_RETRY_SUPPRESS_MS = 60 * 60 * 1000;

export interface MergeCompletionFingerprint {
	fingerprint: string;
	precise: boolean;
}

export function parseTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

export function shouldSuppressMergePrompt(
	state: MergeCompletionPromptState | null | undefined,
	fingerprint: MergeCompletionFingerprint,
	nowMs: number,
): boolean {
	if (!state || state.fingerprint !== fingerprint.fingerprint) return false;
	if (fingerprint.precise && state.precise && parseTime(state.dismissedAt) !== null) return true;

	// Unanswered prompts remain eligible after a lifecycle move clears the
	// actor-local reservation; a lost popup must not suppress completion forever.
	if (parseTime(state.dismissedAt) === null) return false;

	const lastPromptTime = Math.max(
		parseTime(state.promptedAt) ?? 0,
		parseTime(state.dismissedAt) ?? 0,
	);
	return lastPromptTime > 0 && nowMs - lastPromptTime < MERGE_PROMPT_FALLBACK_SUPPRESS_MS;
}
