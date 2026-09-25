import type { NoteSource, Project, Task } from "../../shared/types";

/**
 * Who asked for a board change, fixed by the door: the GUI RPC adapter always passes
 * `user`, the CLI socket adapter always `agent`. Never derived from a caller-supplied
 * field — a self-declared value must not become a policy input. The rules that read
 * it (title guard, note source default, manual-completion toast) live in the ops.
 */
export type BoardActor = { kind: "user" } | { kind: "agent" };

export const USER_ACTOR: BoardActor = { kind: "user" };
export const AGENT_ACTOR: BoardActor = { kind: "agent" };

/** Default note source for an actor; a caller-supplied `source` is a note attribute, not an actor. */
export function noteSourceOf(actor: BoardActor): NoteSource {
	return actor.kind === "user" ? "user" : "ai";
}

/**
 * `applied` — something was written and pushed. `noop` — the request matched what
 * is stored: nothing written, nothing pushed. `guardRejected` — a rule refused every
 * requested change (see `rejected`); nothing written, nothing pushed.
 */
export type BoardVerdict = "applied" | "noop" | "guardRejected";

export type BoardPushEvent = "taskUpdated" | "projectUpdated" | "manualCompletionChanged";

/**
 * The side effects an operation has outside its own files. Production binds them in
 * `runtime.ts`; tests pass a recording implementation.
 */
export interface BoardPorts {
	/** Fans out to every window, browser client and peer instance in production. */
	push(name: BoardPushEvent, payload: Record<string, unknown>): void;
	/**
	 * Drop the lifecycle's merge-prompt reservation after a completion-policy flip.
	 * Borrowed from the lifecycle (it runs outside the actor mailbox, as before).
	 */
	clearMergeNotification(taskId: string): void | Promise<void>;
}

export interface TaskOpResult {
	verdict: BoardVerdict;
	task: Task;
	/** Fields a guard refused while the rest of the request may still have applied. */
	rejected: "title"[];
}

export interface ProjectOpResult<T> {
	verdict: BoardVerdict;
	project: Project;
	result: T;
}

export function pushTaskUpdated(ports: BoardPorts, project: Project, task: Task): void {
	ports.push("taskUpdated", { projectId: project.id, task });
}
