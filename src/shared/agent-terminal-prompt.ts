/**
 * The rules that decide whether a harness prompt-submit hook is the human.
 *
 * A `UserPromptSubmit` hook fires for whatever was submitted in the agent's pane,
 * and dev3 types into that pane constantly — peer `dev3 message` deliveries, the
 * Send-to-agent and Send-later buttons, hand-offs, and the task brief handed to
 * the agent as a launch argument (verified: Claude Code fires the hook for that
 * too). So the event alone proves nothing, and the absence of an envelope proves
 * nothing either.
 *
 * What does prove it is subtraction with a receipt: dev3 records the text of
 * every prompt IT causes, and a submission that matches none of them is the
 * user's. This module holds the pure half of that — normalisation, the envelope
 * test, the match, and the preview that is the only part of a prompt ever
 * written down.
 */

/**
 * Longest preview kept for one terminal submission.
 *
 * The prompt body itself is never stored: recording every prompt the user types
 * would be a far wider data set than the message log (which only holds text
 * deliberately addressed to another task) and would routinely capture pasted
 * secrets. A clamped one-line preview is what the traffic surfaces render, and
 * nothing here needs more.
 */
export const TERMINAL_PROMPT_PREVIEW_MAX_CHARS = 240;

/**
 * Shortest dev3-typed text that may be matched by containment rather than by
 * equality. A two-character hand-off ("ok") would otherwise be a substring of
 * half the prompts a human writes and would silently swallow their rows.
 */
export const TYPED_PROMPT_MIN_NEEDLE_CHARS = 16;

/** The first line of everything dev3 wraps before typing it into a pane. */
export const DEV3_ENVELOPE_TAGS = ["<dev3-ai-message>", "<dev3-artifact-message>"] as const;

/**
 * One submitted text, comparable. Line endings differ between the pane, the hook
 * payload and the string dev3 typed, and trailing whitespace is added by the
 * submit itself — neither difference is a different message.
 */
export function normalizeSubmittedPrompt(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

/**
 * True when the submission opens with a dev3 envelope, which no human writes and
 * dev3 always writes for a peer message, a hand-off or an artifact reply.
 *
 * Only the NEGATIVE direction is trustworthy: wrapped is never the user, but
 * unwrapped is not yet the user. It stays as a second, independent test so a
 * peer's message is still recognised if its claim expired or was consumed.
 */
export function isDev3EnvelopeText(text: string): boolean {
	const firstLine = normalizeSubmittedPrompt(text).split("\n", 1)[0]?.trimStart() ?? "";
	return DEV3_ENVELOPE_TAGS.some((tag) => firstLine.startsWith(tag));
}

/** A pseudo-XML tag opening the first line: `<task-notification>`, `<command-name>`, … */
const MACHINE_TAG_RE = /^<[a-z][a-z0-9-]*>/u;

/**
 * True when the submission opens with a machine tag, whoever wrote it.
 *
 * The harness submits prompts of its own, and they are indistinguishable from a
 * human's at the hook: Claude Code raises a second `UserPromptSubmit` carrying
 * `<task-notification>…` when a subagent finishes — same session, its own
 * prompt id, nothing marking it as generated. Observed, not theorised (claude
 * 2.1.267). Slash-command scaffolding and reminders wear the same shape.
 *
 * So the rule is structural and deliberately wider than any list dev3 could keep
 * current: a submission that begins with a tag is machinery and stays
 * unclassified. A human who genuinely opens a prompt with `<foo>` loses that one
 * row — the direction we choose every time.
 */
export function looksMachineGenerated(text: string): boolean {
	const firstLine = normalizeSubmittedPrompt(text).split("\n", 1)[0]?.trimStart() ?? "";
	return MACHINE_TAG_RE.test(firstLine);
}

/**
 * Shortest dev3-typed text that may be matched as a PREFIX. A launch brief and a
 * hand-off always lead their submission, but the harness appends to them (the
 * dev3 protocol body, an interpolated append-prompt), so equality would miss
 * them and a short task description would then be recorded as a prompt the user
 * typed.
 */
export const TYPED_PROMPT_MIN_PREFIX_CHARS = 4;

/**
 * True when `submitted` carries text dev3 typed.
 *
 * Three ways to match, widest first, because the pane composes: a held burst
 * joins several messages with a separator, a board snapshot is appended after
 * them, a launch argument is extended with the protocol body, and the whole
 * thing arrives as one prompt. Every piece dev3 put there disqualifies the
 * submission from being called the user's.
 *
 * The length floors run in the safe direction on purpose. Matching too eagerly
 * costs one unrecorded human prompt; matching too little writes down a peer's
 * message as something the user said, which is the failure this must not have.
 */
export function submissionMatchesTypedText(submitted: string, typed: string): boolean {
	const haystack = normalizeSubmittedPrompt(submitted);
	const needle = normalizeSubmittedPrompt(typed);
	if (!needle || !haystack) return false;
	if (haystack === needle) return true;
	if (needle.length >= TYPED_PROMPT_MIN_PREFIX_CHARS && haystack.startsWith(needle)) return true;
	if (needle.length < TYPED_PROMPT_MIN_NEEDLE_CHARS) return false;
	return haystack.includes(needle);
}

/**
 * The single line stored for a submission: whitespace collapsed so a pasted
 * block does not render as one very tall row, and clamped.
 */
export function terminalPromptPreview(text: string): string {
	const oneLine = normalizeSubmittedPrompt(text).replaceAll(/\s+/gu, " ");
	if (oneLine.length <= TERMINAL_PROMPT_PREVIEW_MAX_CHARS) return oneLine;
	return `${oneLine.slice(0, TERMINAL_PROMPT_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * The harnesses whose prompt-submit hook dev3 reads. Both hand over a stable
 * per-submission id, which is what makes exactly-once provable rather than
 * guessed: Claude Code's `prompt_id`, Codex's `turn_id`.
 */
export type PromptSubmitHarness = "claude" | "codex";

/**
 * Identity of ONE submission, stable across a redelivered hook.
 *
 * Null when the harness gave no ids at all — the caller then has no way to tell a
 * retry from a second submission, and refuses to record rather than risk writing
 * the same prompt twice.
 */
export function promptSubmissionKey(
	harness: PromptSubmitHarness,
	sessionId: string | null | undefined,
	submissionId: string | null | undefined,
): string | null {
	if (!sessionId && !submissionId) return null;
	return `${harness}:${sessionId ?? "no-session"}:${submissionId ?? "no-submission"}`;
}
