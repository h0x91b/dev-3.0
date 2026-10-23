import type { CliResumeOutcome } from "./agent-resume";

/** Why `dev3 task hibernate` found nothing to free. Nothing was stopped. */
export type HibernateRefusalReason = "already-hibernated" | "draft" | "not-active" | "no-worktree" | "not-running";

export type CliHibernateOutcome =
	| { outcome: "hibernated"; taskId: string; seq: number; freedRssBytes: number | null }
	| { outcome: "nothing-to-free"; taskId: string; seq: number; reason: HibernateRefusalReason; message: string }
	| { outcome: "declined"; taskId: string; seq: number; stale?: boolean };

/** `--resume` reports exactly what `dev3 agent resume` does; `--shell` has its own two answers. */
export type CliWakeOutcome =
	| { outcome: "not-hibernated"; taskId: string; seq: number }
	| { outcome: "woke-shell"; taskId: string; seq: number; backend: "tmux" | "native" }
	| { outcome: "resume"; resume: CliResumeOutcome }
	| { outcome: "declined"; taskId: string; seq: number; stale?: boolean };

/** What an agent asks to do to a task's session, shown in the launch-approval dialog instead of an agent picker. */
export type AgentSessionAction =
	| { kind: "hibernate"; paneCount: number }
	| { kind: "wake-shell" };

/** The first line of a task woken with a plain shell: the agent did not start, and its conversation is still saved. */
export const WAKE_SHELL_NOTICE =
	"dev3: woken with a plain shell — the agent was not started. Its conversation is still saved: exit this shell, then choose Resume Session (or run `dev3 agent resume`).";
