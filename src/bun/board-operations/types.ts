import type { NoteSource, Project, Task } from "../../shared/types";

/**
 * Who asked for a board change. The door a request came through (GUI RPC or CLI
 * socket) is NOT the actor: adapters decide it explicitly, so a rule like "an agent
 * may not overwrite a user-edited title" is enforced the same way from either door.
 */
export type BoardActor = { kind: "user" } | { kind: "agent" };

export const USER_ACTOR: BoardActor = { kind: "user" };
export const AGENT_ACTOR: BoardActor = { kind: "agent" };

export function actorFromNoteSource(source: NoteSource | undefined, fallback: BoardActor): BoardActor {
	if (source === "user") return USER_ACTOR;
	if (source === "ai") return AGENT_ACTOR;
	return fallback;
}

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
	/** A task's completion policy flipped: the lifecycle drops its merge-prompt reservation. */
	manualCompletionChanged(taskId: string): void | Promise<void>;
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
