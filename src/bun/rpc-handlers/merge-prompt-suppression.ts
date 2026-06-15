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
	// Permanent suppression only for an explicit user dismissal of this exact
	// head.
	if (fingerprint.precise && state.precise && parseTime(state.dismissedAt) !== null) return true;

	// An unanswered prompt (reserved but never dismissed) must keep coming back:
	// a lost or never-seen popup should re-appear whenever the task is eligible
	// again, independent of any time window. clearMergeNotification() (called on
	// every status change) drops the in-memory throttle, so a fresh poll re-offers
	// completion once the task re-enters an eligible status. Without this, a popup
	// reserved while in review-by-user but missed before the task flipped to
	// in-progress/review-by-ai stayed muted for an hour and was lost.
	if (parseTime(state.dismissedAt) === null) return false;

	// The user responded under a non-precise fingerprint, so we can't prove it is
	// the same head: mute for a window instead of permanently.
	const lastPromptTime = Math.max(
		parseTime(state.promptedAt) ?? 0,
		parseTime(state.dismissedAt) ?? 0,
	);
	return lastPromptTime > 0 && nowMs - lastPromptTime < MERGE_PROMPT_FALLBACK_SUPPRESS_MS;
}
