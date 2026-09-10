/**
 * The receipts for everything dev3 types into a task's agent.
 *
 * A prompt-submit hook cannot say who submitted, so dev3 answers it by
 * elimination: every prompt dev3 causes leaves a claim here, and a hook whose
 * text matches no claim is the human at the keyboard. The claim is consumed when
 * it matches, so two identical peer messages need two claims and the second
 * submission cannot be waved through by the first one's receipt.
 *
 * In memory on purpose. A claim is only meaningful between "dev3 decided to type
 * this" and "the harness reported it submitted", which is seconds to minutes
 * inside one app process; persisting it would outlive the pane it describes and
 * would be one more place a prompt's text sits on disk.
 *
 * Known limit, stated rather than papered over: when another dev3 app process
 * owns the pane's writer lease, the delivery is forwarded to it and the claim is
 * still noted here, in the process that decided to send. The hook reaches the
 * process that owns the task's CLI socket. Those are the same process in every
 * ordinary install; two app processes sharing one task are the case where a
 * dev3-typed prompt can be recorded as the user's.
 */

import { normalizeSubmittedPrompt, submissionMatchesTypedText } from "../shared/agent-terminal-prompt";

/**
 * How long a receipt is worth keeping. A held message waits for the pane to go
 * quiet before a single character is typed, and the wait is open-ended, so the
 * window has to be generous — but not unbounded: an expired claim only costs a
 * suppressed row, while an immortal one would swallow a human prompt that
 * happens to quote it hours later.
 */
export const TYPED_PROMPT_CLAIM_TTL_MS = 30 * 60_000;

/**
 * Receipts kept per task. Deliveries far outnumber submissions (a message that
 * never lands still leaves a claim), so the list is bounded and the oldest goes
 * first.
 */
export const TYPED_PROMPT_CLAIM_LIMIT = 64;

interface TypedPromptClaim {
	text: string;
	expiresAt: number;
}

let claimsByTask = new Map<string, TypedPromptClaim[]>();

function live(claims: TypedPromptClaim[], now: number): TypedPromptClaim[] {
	return claims.filter((claim) => claim.expiresAt > now);
}

/**
 * Record that dev3 is about to type `text` into `taskId`'s agent. Called for the
 * text as dev3 hands it over, before the pane composes a burst around it —
 * matching is by containment precisely so that composition does not matter.
 */
export function noteDev3TypedPrompt(taskId: string, text: string, now: number = Date.now()): void {
	const normalized = normalizeSubmittedPrompt(text);
	if (!normalized) return;
	const existing = live(claimsByTask.get(taskId) ?? [], now);
	existing.push({ text: normalized, expiresAt: now + TYPED_PROMPT_CLAIM_TTL_MS });
	claimsByTask.set(taskId, existing.slice(-TYPED_PROMPT_CLAIM_LIMIT));
}

/**
 * Consume the receipt for `submitted`, if dev3 left one.
 *
 * True means dev3 caused this submission and it must not be recorded as the
 * user's. Consuming is the whole point: the same text typed twice is two
 * submissions and needs two receipts.
 */
export function claimDev3TypedPrompt(taskId: string, submitted: string, now: number = Date.now()): boolean {
	const claims = live(claimsByTask.get(taskId) ?? [], now);
	// Newest first: a re-sent message should spend its own receipt rather than an
	// older one that another submission may still be about to match.
	let index = -1;
	for (let i = claims.length - 1; i >= 0; i -= 1) {
		const claim = claims[i];
		if (claim && submissionMatchesTypedText(submitted, claim.text)) {
			index = i;
			break;
		}
	}
	if (index === -1) {
		claimsByTask.set(taskId, claims);
		return false;
	}
	claims.splice(index, 1);
	claimsByTask.set(taskId, claims);
	return true;
}

/** How many receipts are still live for a task. Diagnostics and tests only. */
export function typedPromptClaimCount(taskId: string, now: number = Date.now()): number {
	return live(claimsByTask.get(taskId) ?? [], now).length;
}

/** Test seam: forget every receipt. */
export function resetTypedPromptClaims(): void {
	claimsByTask = new Map();
}
