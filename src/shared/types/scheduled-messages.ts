import type { AgentMessageOrigin } from "../agent-message-log";

/**
 * Where a scheduled message is delivered ("Send later").
 * - `agent` (default): resolved dynamically at fire time via the live agent-pane
 *   registry — the agent pane is recreated with fresh ids, so we never store one.
 * - `pane`: a concrete tmux pane id picked from the live layout. Valid only
 *   within one tmux-server lifetime; a stale id takes the drop-with-notice path.
 */
export type ScheduledMessageTarget =
	| { kind: "agent" }
	| { kind: "pane"; paneId: string };

/**
 * A one-shot piece of text queued to a task's live agent/pane, delivered by
 * typing it + Enter when {@link ScheduledMessage.at} passes. The messaging
 * counterpart to {@link ScheduledLaunch} (which defers *spawning* a task); this
 * pokes an already-running agent. See {@link Task.scheduledMessages}.
 */
export interface ScheduledMessage {
	/** Stable id for cancel / send-now. */
	id: string;
	/** The text delivered (send-keys paste + Enter). */
	text: string;
	/**
	 * The sender's one-line summary of the message, carried to the delivery
	 * outcome so the message log stores it. Required on everything `dev3 message`
	 * queues; absent only where dev3 itself hands a task some text.
	 */
	subject?: string;
	/** ISO timestamp when it should be delivered. */
	at: string;
	/** Delivery target; `{ kind: "agent" }` by default. */
	target: ScheduledMessageTarget;
	/** Set when another task's agent sent it — wraps the text at fire time. */
	source?: AgentMessageSource;
	/**
	 * Provenance carried from the moment of authoring to the moment of delivery,
	 * because a "Send later" fires hours after the user wrote it and nothing at
	 * fire time could tell who did. Additive and optional in `tasks.json`.
	 */
	origin?: AgentMessageOrigin;
	/**
	 * The file the real body was written to when it was too large to type, leaving
	 * {@link text} a pointer to it. Carried so the message log can say a row holds a
	 * pointer rather than a body, instead of guessing from the wording.
	 */
	spilledPath?: string;
	/**
	 * The one agent this goes to: the agent that queued a self-reminder, or the one
	 * a sender addressed with `--agent`. The fire never reaches a sibling instead.
	 * Absent for task-addressed messages. Additive: older versions ignore it.
	 */
	author?: ScheduledMessageAuthor;
}

/**
 * One agent process in a task: a self-reminder's author, an `--agent` address, or
 * a message's sender. The identity is the PROCESS (pid + start time): pane ids are
 * reused across tmux servers, and an agent that exits leaves its pane as a shell.
 */
export interface ScheduledMessageAuthor {
	/** Pane the agent ran in (tmux `%N` or native pane id). */
	paneId: string;
	/** That pane's agent conversation id from `sessionState`, when known. */
	sessionId: string | null;
	/**
	 * The pane's generation: tmux server token, or the native registry session id.
	 * Never reinterpreted: older versions compare it while the agent is alive.
	 */
	paneToken: string;
	/**
	 * Native main agent only: start signature of the pane's root process, which a
	 * restart changes while `paneToken` (deterministic per pane) does not. Additive;
	 * absent on tmux and on records written before it, which are never rebound.
	 */
	paneGeneration?: string;
	/** Start signature of the agent process itself: `pid@linux:<boot id>:<start tick>` on Linux, `pid@<ps lstart>` elsewhere. */
	agentProcess: string;
}

/**
 * The task whose agent authored a cross-task message. Present only for
 * agent-to-agent traffic (`dev3 message` run inside another task's worktree);
 * absent for anything the human sends. Drives the pseudo-XML envelope in
 * `wrapAgentMessage` so the receiver knows who wrote it and how to reply.
 */
export interface AgentMessageSource {
	/** Sender task id (used to skip wrapping when a task messages itself). */
	taskId: string;
	/** Sender's stable `seq` — the reply address (`--task seq:<N>`) unless it is a variant. */
	seq: number;
	/** Sender's variant index, when it is one attempt of a variant group. */
	variantIndex?: number | null;
	/**
	 * Another live task on the sender's board still answers to the same `seq`, so
	 * `--task seq:<N>` would be rejected as ambiguous and the reply address has to
	 * be the raw id. Counted at resolve time — see `seqIsShared`. Absent on a
	 * record queued before this field existed.
	 */
	seqShared?: boolean;
	/** Sender's title, for human-readable context in the envelope. */
	title?: string;
	/**
	 * Stamped by the app, never by the sender, when the sender is a coordinator task:
	 * it relays the user's will, and the receiver's auto-mode classifier keys on the
	 * `<from-role>` tag this becomes (`DEV3_AUTO_MODE_COORDINATOR_ENTRY`).
	 */
	role?: "coordinator";
	/**
	 * Sender's project. Carried so the delivery notification can be dropped when
	 * EITHER side belongs to a sensitive project — the toast names both tasks, so
	 * gating on the receiver alone would leak the sender's title on camera — and so
	 * a cross-project reply command can carry `--project` (`agentReplyCommand`).
	 */
	projectId?: string;
	/** The sending agent itself, so the reply command reaches it and no sibling. */
	agent?: ScheduledMessageAuthor;
	/** Why no sending agent could be proven; the envelope then offers no reply command. */
	agentUnavailable?: string;
}

/** Per-task cap on pending scheduled messages; scheduling past this is rejected. */
export const MAX_SCHEDULED_MESSAGES_PER_TASK = 20;

/**
 * Max length (chars) of a single message's text; longer is rejected outright.
 * Well above what a terminal can be typed into — anything past
 * {@link AGENT_MESSAGE_SPILL_THRESHOLD_BYTES} is handed over as a file instead.
 */
export const MAX_SCHEDULED_MESSAGE_LENGTH = 80_000;

/**
 * UTF-8 bytes of TYPED text — the whole envelope, header included, not the body —
 * that still go into a pane as text. Past this the body is written to a file and the
 * agent is typed a short pointer to it inside the same envelope.
 *
 * 1 000 because the receiving CLI reads its pty about 1 KiB at a time (the cut lands
 * at byte 1 022 every time it was measured): a delivery longer than one read arrives
 * in several chunks, Claude Code folds the first into a `[Pasted text #N]` attachment
 * and intermittently drops that attachment at submit — the head of the message is
 * gone and nothing says so (issue #1608, anthropics/claude-code#90910). What fits one
 * read is never split, so nothing typed may exceed it. Measured on the envelope
 * because that is what the pty sees; a 300-byte header on an 800-byte body is
 * already two reads. See `decisions/2026/09/03/spill-at-the-pty-chunk-boundary.md`.
 */
export const AGENT_MESSAGE_SPILL_THRESHOLD_BYTES = 1_000;
