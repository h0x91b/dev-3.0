import type { AgentFamily } from "./types";

/**
 * How the conversation id handed to the harness was arrived at.
 * - `exact`: the stored id, with its transcript found on disk (or chosen from disk, for Codex).
 * - `substituted`: the stored id had no transcript, so the newest surviving one replaces it.
 * - `unverified`: the stored id, passed through because this harness's store cannot be read.
 * - `agent-latest`: no id at all — the harness picks its own latest, and may start a new conversation.
 * - `fresh`: the harness cannot resume at all, so it starts over from the task description.
 */
export type ResumePaneMode = "exact" | "substituted" | "unverified" | "agent-latest" | "fresh";

export interface ResumePaneReport {
	/** Position in the task's saved panes; 0 is the main pane. */
	index: number;
	agentId: string | null;
	configId: string | null;
	accountId: string | null;
	agentFamily: AgentFamily | null;
	/** The id the task had saved for this pane before the resume. */
	storedSessionId: string | null;
	/** The conversation the harness reopens; null for `agent-latest` and `fresh`. */
	sessionId: string | null;
	mode: ResumePaneMode;
	/** `skipped`/`failed` panes stay saved on the task and can be resumed again later. */
	status: "resumed" | "skipped" | "failed";
	paneId: string | null;
	detail?: string;
}

export interface TaskResumeResult {
	taskId: string;
	seq: number;
	projectId: string;
	backend: "tmux" | "native";
	/** Present on the tmux backend only. */
	tmux?: { socket: string; session: string };
	/** The task was hibernated and this resume woke it. */
	woke: boolean;
	panes: ResumePaneReport[];
}

/** Why a resume was refused before anything was launched. */
export type ResumeUnavailableReason = "not-active" | "draft" | "no-worktree" | "no-saved-session" | "session-id-unknown" | "harness-cannot-resume";

export type CliResumeOutcome =
	| { outcome: "resumed"; resume: TaskResumeResult }
	| { outcome: "already-running"; taskId: string; seq: number; backend: "tmux" | "native" }
	| { outcome: "unavailable"; taskId: string; seq: number; reason: ResumeUnavailableReason; message: string; panes?: ResumePaneReport[] }
	| { outcome: "declined"; taskId: string; seq: number; stale?: boolean };

/** The saved panes an approval dialog shows for a resume request: what will be restored, never changed. */
export interface ResumeDialogPane {
	agentId: string | null;
	configId: string | null;
	/** The saved id; the resume itself may heal it to the newest surviving transcript. */
	sessionId: string | null;
}
