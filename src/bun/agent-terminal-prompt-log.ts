/**
 * Recording ordinary human prompts typed into a task's terminal, so agent
 * traffic shows the person who started a turn and not only the agents talking
 * to each other.
 *
 * The event comes from the harness's own prompt-submit hook. Everything hard
 * about it is deciding whether the human submitted it — see
 * `agent-typed-prompt-claims.ts` for the receipts this consults, and
 * `../shared/agent-terminal-prompt.ts` for the pure rules.
 *
 * The row carries a clamped preview, never the prompt. `origin: "user"` is
 * stamped here because this path CAN prove a human acted: the harness reported a
 * submission, dev3 holds no receipt for it, and it carries no dev3 envelope.
 */

import type { Project, Task } from "../shared/types";
import {
	type PromptSubmitHarness,
	isDev3EnvelopeText,
	looksMachineGenerated,
	normalizeSubmittedPrompt,
	promptSubmissionKey,
	terminalPromptPreview,
} from "../shared/agent-terminal-prompt";
import { appendAgentMessageLog } from "./agent-message-log";
import { claimDev3TypedPrompt } from "./agent-typed-prompt-claims";
import { createLogger } from "./logger";

const log = createLogger("agent-terminal-prompt");

/**
 * Why a submission was or was not written down. Returned rather than logged
 * alone so the hook adapter and its tests can assert the reason, and so a
 * silently-dropped prompt is never indistinguishable from a recorded one.
 */
export type TerminalPromptOutcome =
	| "recorded"
	| "empty"
	| "envelope"
	| "machine-tagged"
	| "dev3-typed"
	| "duplicate"
	| "unidentified";

/**
 * How long one submission id is remembered. A hook can be delivered twice (a
 * retry, or two dev3 processes reachable on the same socket path), and the two
 * deliveries carry the SAME id — which is the only reason exactly-once is
 * provable here rather than guessed from text and timing.
 */
export const PROMPT_SUBMISSION_MEMORY_MS = 10 * 60_000;

/** Bounded so a long-lived app cannot grow this without limit. */
export const PROMPT_SUBMISSION_MEMORY_LIMIT = 512;

let seenSubmissions = new Map<string, number>();

function alreadySeen(key: string, now: number): boolean {
	for (const [seen, at] of seenSubmissions) {
		if (at <= now - PROMPT_SUBMISSION_MEMORY_MS) seenSubmissions.delete(seen);
	}
	if (seenSubmissions.has(key)) return true;
	seenSubmissions.set(key, now);
	if (seenSubmissions.size > PROMPT_SUBMISSION_MEMORY_LIMIT) {
		const oldest = seenSubmissions.keys().next().value;
		if (oldest !== undefined) seenSubmissions.delete(oldest);
	}
	return false;
}

/** Test seam: forget which submissions were recorded. */
export function resetPromptSubmissionMemory(): void {
	seenSubmissions = new Map();
}

export interface TerminalPromptSubmission {
	project: Project;
	task: Task;
	harness: PromptSubmitHarness;
	prompt: string;
	sessionId?: string | null;
	submissionId?: string | null;
}

/**
 * Record one submission as the user's, or say why it is not one.
 *
 * The order of the tests is the argument: a submission dev3 caused is thrown out
 * before anything is written, and only what survives all of them is called the
 * human's.
 */
export function recordTerminalPromptSubmission(
	submission: TerminalPromptSubmission,
	now: Date = new Date(),
): TerminalPromptOutcome {
	const { project, task, harness, prompt } = submission;
	const text = normalizeSubmittedPrompt(prompt);
	if (!text) return "empty";
	if (isDev3EnvelopeText(text)) return "envelope";
	// Whatever else opens with a tag is the harness talking to itself — a subagent
	// completion notice, slash-command scaffolding, a reminder. dev3 left no
	// receipt for those because dev3 did not type them, so without this they would
	// be recorded as the user.
	if (looksMachineGenerated(text)) return "machine-tagged";
	if (claimDev3TypedPrompt(task.id, text, now.getTime())) return "dev3-typed";

	const key = promptSubmissionKey(harness, submission.sessionId, submission.submissionId);
	// No identity means no way to tell a redelivered hook from a second prompt.
	// Writing anyway would double-count a turn in the graph, which is the exact
	// failure this feature was asked not to introduce.
	if (!key) return "unidentified";
	if (alreadySeen(key, now.getTime())) return "duplicate";

	appendAgentMessageLog(project, {
		at: now.toISOString(),
		fromTaskId: null,
		fromSeq: null,
		toTaskId: task.id,
		toSeq: task.seq,
		...(task.title ? { toTitle: task.title } : {}),
		toProjectId: project.id,
		kind: "immediate",
		origin: "user",
		body: terminalPromptPreview(text),
		bodyKind: "text",
		status: "delivered",
	}, now);
	log.info("recorded a terminal prompt as the user's", { taskId: task.id.slice(0, 8), harness });
	return "recorded";
}
