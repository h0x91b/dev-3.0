/** What `dev3 agent exit` is told: the extra agent is scheduled to close, or why it is not. */
export type CliAgentExitOutcome =
	| { outcome: "scheduled"; taskId: string; seq: number; paneId: string; agent: string; self: boolean; already: boolean }
	| { outcome: "declined"; taskId: string; seq: number; stale?: boolean }
	/** `main-agent` maps to its own exit code, so an agent that picked the wrong target is pointed at task completion. */
	| { outcome: "refused"; reason: "main-agent" | "not-extra"; message: string };

export const MAIN_AGENT_EXIT_MESSAGE =
	"This is the task's main agent; dev3 agent exit only closes extra agents. To finish the task, request completion: dev3 task move --status completed";
