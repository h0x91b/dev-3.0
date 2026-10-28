import type { AgentMessageSource, Project, Task, TaskOriginParent } from "../../shared/types";
import { seqIsShared } from "../../shared/agent-message-envelope";
import { ID_PREFIX_MIN_LENGTH, getTaskTitle, isCoordinatorTask, parentTaskIdOf } from "../../shared/types";
import * as data from "../data";
import { loadEffectiveTaskHistory } from "../task-blobs";
import { captureSenderAgent } from "../scheduled-message-author";
import { requireExternalSender } from "../external-senders";
import type { ExternalSenderRequester } from "../../shared/external-senders";

const MIN_PREFIX_LENGTH = ID_PREFIX_MIN_LENGTH;

export function findByIdPrefix<T extends { id: string }>(items: T[], prefix: string, entityName: string): T | null {
	const exact = items.find((item) => item.id === prefix);
	if (exact) return exact;

	if (prefix.length < MIN_PREFIX_LENGTH) return null;

	const matches = items.filter((item) => item.id.startsWith(prefix));
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		const ids = matches.map((m) => m.id.slice(0, 12)).join(", ");
		throw new Error(`Ambiguous ${entityName} prefix "${prefix}" matches ${matches.length} items (${ids}). Use a longer prefix.`);
	}
	return matches[0];
}

/**
 * Parse a stable `seq:<N>` task reference. Seq is printed by `task create` and
 * shown on every card; unlike the id it survives launches (all variants of one
 * logical task share it), so it is the safe handle for stored references.
 */
export function parseSeqRef(ref: string): number | null {
	const match = /^seq:(\d+)$/.exec(ref);
	return match ? Number(match[1]) : null;
}

const VARIANT_NEEDS_SEQ =
	'--variant narrows a variant group addressed by seq. Pass `--task seq:<N> --variant <i>`.';

/** The seq resolved, but no member carries the requested `--variant <i>`. */
class VariantNotFoundError extends Error {}

/** The variant indices a seq actually answers to, for a "no such variant" error. */
function describeLiveVariants(matches: Task[]): string {
	const indices = matches
		.map((m) => m.variantIndex)
		.filter((i): i is number => i != null)
		.sort((a, b) => a - b);
	if (indices.length === 0) return "It is not a variant group — drop --variant.";
	return `Live variants: ${indices.join(", ")}.`;
}

/**
 * Resolve a task reference — full id, ≥8-char id prefix, or `seq:<N>` — against
 * one project's task list. Throws on ambiguity (a variant group shares one seq;
 * a short prefix can match several ids), returns null when nothing matches.
 *
 * `variantIndex` is `dev3 message --variant <i>` and nothing else passes it: it
 * narrows the same-seq matches to the one member carrying that index. It is a
 * plain filter even when the seq is already unambiguous, so a group's survivor
 * keeps answering to the address it handed out while its siblings were alive —
 * `variantIndex` is permanent, the collision that minted it is not.
 */
export function findTaskByRef(tasks: Task[], ref: string, variantIndex?: number): Task | null {
	const seq = parseSeqRef(ref);
	if (seq === null) {
		if (variantIndex !== undefined) throw new Error(VARIANT_NEEDS_SEQ);
		return findByIdPrefix(tasks, ref, "task");
	}
	const matches = tasks.filter((t) => t.seq === seq);
	if (variantIndex !== undefined && matches.length > 0) {
		const picked = matches.filter((t) => t.variantIndex === variantIndex);
		if (picked.length === 0) {
			throw new VariantNotFoundError(`Task ref "${ref}" has no variant ${variantIndex}. ${describeLiveVariants(matches)}`);
		}
		if (picked.length > 1) {
			const ids = picked.map((m) => m.id.slice(0, 8)).join(", ");
			throw new Error(`Task ref "${ref}" matches ${picked.length} tasks with variant ${variantIndex} (${ids}). Address one of them by id.`);
		}
		return picked[0];
	}
	if (matches.length > 1) {
		const ids = matches.map((m) => m.id.slice(0, 8)).join(", ");
		throw new Error(`Task ref "${ref}" matches ${matches.length} variant tasks (${ids}). Address one of them by id, or with \`dev3 message\` by \`--variant <i>\`.`);
	}
	return matches[0] ?? null;
}

/**
 * Actionable not-found error: ids minted before the stable-id fix were re-keyed
 * when the task was launched with variants, so stored ids can dangle — point
 * the caller at the stable seq handle instead of a bare failure.
 */
/**
 * `scopedProject` is the project the lookup was restricted to (explicit
 * `--project`, or the caller's own worktree). Naming it turns the commonest
 * failure — an agent addressing a task on ANOTHER board, where the CLI silently
 * stamped its own project on the request — into an actionable hint instead of an
 * id-drift wild goose chase.
 */
export function taskNotFoundError(ref: string, scopedProject?: Project): Error {
	const scope = scopedProject
		? `Task not found in project "${scopedProject.name}": ${ref}. If it lives on another board, pass ` +
			`\`--project <id>\` (\`dev3 projects list\`). `
		: `Task not found: ${ref}. `;
	return new Error(
		`${scope}If the task was launched by an older app version its id may have changed — ` +
		"run `dev3 tasks list` to find it by seq, or address it as `--task seq:<N>`.",
	);
}

/**
 * The same not-found error, plus the boards the ref DOES resolve on.
 *
 * A scoped lookup must never answer with a stranger's task, but "not found in
 * project X" alone strands a caller whose peer lives on another board — they
 * cannot pass `--project` without knowing which one. Naming the boards keeps the
 * scope strict and the next command obvious. A scan failure degrades to the
 * plain message rather than swallowing the real error.
 */
export async function scopedTaskNotFoundError(ref: string, scopedProject: Project): Promise<Error> {
	const base = taskNotFoundError(ref, scopedProject);
	try {
		const elsewhere: string[] = [];
		for (const project of [...await data.loadProjects(), ...await data.loadVirtualProjects()]) {
			if (project.id === scopedProject.id) continue;
			try {
				// A ref that is ambiguous ON that board still answers the question
				// being asked here — the board carries it. Ambiguity is that board's
				// problem once the caller aims at it.
				if (findTaskByRef(await data.loadTasks(project), ref)) {
					elsewhere.push(`"${project.name}" (--project ${project.id.slice(0, 8)})`);
				}
			} catch (err) {
				// "Task ref … matches N variant tasks" means that board does carry it;
				// an unreadable tasks.json means nothing and is skipped.
				if (err instanceof Error && err.message.startsWith("Task ref")) {
					elsewhere.push(`"${project.name}" (--project ${project.id.slice(0, 8)})`);
				}
			}
		}
		if (elsewhere.length === 0) return base;
		return new Error(`${base.message}\n${ref} does resolve on: ${elsewhere.join(", ")}.`);
	} catch {
		return base;
	}
}

/**
 * Put the task's archived history back on the record, leaving a task with no
 * history at all untouched rather than stamping an empty array on it — the CLI's
 * task shape stays exactly what it was before the sidecar.
 */
export async function withArchivedHistory(project: Project, task: Task): Promise<Task> {
	const history = await loadEffectiveTaskHistory(project, task);
	return history.length > 0 ? { ...task, history } : task;
}

/**
 * `task.show` answers with the parent resolved, so `dev3 task show`/`current`
 * can print "Created by" without a second request. `originParent` is null when
 * the parent no longer exists, absent when the task has no task origin.
 */
export async function withOriginParent(task: Task): Promise<Task & { originParent?: TaskOriginParent | null }> {
	const parentId = parentTaskIdOf(task);
	if (!parentId) return task;
	const found = await resolveTaskAcrossProjects(parentId).catch(() => null);
	if (!found || found.task.id !== parentId) return { ...task, originParent: null };
	const { project, task: parent } = found;
	const isGroup = parent.groupId !== null && (await data.loadTasks(project)).some((t) => t.id !== parent.id && t.groupId === parent.groupId);
	return {
		...task,
		originParent: {
			id: parent.id,
			projectId: project.id,
			projectName: project.name,
			seq: parent.seq,
			variantIndex: isGroup ? parent.variantIndex : null,
			title: getTaskTitle(parent),
		},
	};
}

/**
 * The task a `dev3 pane` call is about, WITH its project — a pane run needs the
 * task lifecycle env, which only the project can build. Unlike `task.peek` this is
 * never cross-project by intent: an agent drives its own terminal, not a peer's.
 */
export async function requirePaneTask(params: Record<string, unknown>): Promise<{ project: Project; task: Task }> {
	const taskId = params.taskId as string;
	if (!taskId) throw new Error("taskId is required");
	if (params.projectId) {
		const project = await data.getProject(params.projectId as string);
		const task = findTaskByRef(await data.loadTasks(project), taskId);
		if (!task) throw await scopedTaskNotFoundError(taskId, project);
		return { project, task };
	}
	const found = await resolveTaskAcrossProjects(taskId);
	if (!found) throw taskNotFoundError(taskId);
	return found;
}

/**
 * The task whose agent sent this request (`sourceTaskId`), or null for a person
 * at a plain terminal. An id that resolves to nothing is an error rather than a
 * silent "nobody asked", which would skip the user's approval entirely.
 */
export async function resolveRequesterTask(params: Record<string, unknown>, what = "request"): Promise<Task | null> {
	const sourceId = typeof params.sourceTaskId === "string" ? params.sourceTaskId.trim() : "";
	if (!sourceId) return null;
	const found = await resolveTaskAcrossProjects(sourceId);
	if (!found) throw new Error(`Unknown requesting task — cannot attribute the ${what}.`);
	return found.task;
}

/**
 * The external sender a request speaks for (`--as-sender`), or null. Unknown ids
 * throw; a request from inside a task cannot also claim to be a sender.
 */
export function senderRequester(params: Record<string, unknown>): ExternalSenderRequester | null {
	if (params.asSender === undefined) return null;
	const sender = requireExternalSender(params.asSender);
	if (params.sourceTaskId) throw new Error("--as-sender cannot be used from inside a task worktree.");
	return { senderId: sender.id, label: sender.label };
}

/** A task for `dev3 review`: scoped to a project when the CLI knows it, else found across projects. */
export async function resolveReviewTask(taskId: string, projectId: string | undefined): Promise<{ project: Project; task: Task }> {
	if (projectId) {
		const project = await data.getProject(projectId);
		const tasks = await data.loadTasks(project);
		const found = findTaskByRef(tasks, taskId);
		if (!found) throw taskNotFoundError(taskId, project);
		return { project, task: found };
	}
	const found = await resolveTaskAcrossProjects(taskId);
	if (!found) throw taskNotFoundError(taskId);
	return found;
}

export async function resolveTaskAcrossProjects(taskId: string, variantIndex?: number): Promise<{ project: Project; task: Task } | null> {
	// Scan virtual ("Operations") boards too, so `dev3` commands run from inside
	// an operation worktree (no explicit --project) can resolve their task.
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	// Raised here rather than inside the loop: the id-prefix path below swallows
	// everything but "Ambiguous", so a `--variant` misuse would come back as a
	// bare "task not found".
	if (variantIndex !== undefined && parseSeqRef(taskId) === null) throw new Error(VARIANT_NEEDS_SEQ);

	// Seq refs must collect matches across ALL projects instead of returning the
	// first hit: every board counts 1..N, so cross-project collisions are routine
	// and silently picking whichever project iterates first would mutate the
	// wrong task. Id prefixes keep first-match-wins — UUIDs make cross-project
	// collisions unrealistic, and the CLI already guards them (decision 102).
	if (parseSeqRef(taskId) !== null) {
		const matches: Array<{ project: Project; task: Task }> = [];
		// A board carrying the seq but not that variant is a near miss, not a
		// verdict: another board may hold the real group (seq collisions across
		// projects are routine). Kept, and raised only if nothing matched anywhere.
		let variantMiss: VariantNotFoundError | null = null;
		for (const project of projects) {
			try {
				const tasks = await data.loadTasks(project);
				const task = findTaskByRef(tasks, taskId, variantIndex);
				if (task) matches.push({ project, task });
			} catch (err) {
				if (err instanceof VariantNotFoundError) {
					variantMiss ??= err;
					continue;
				}
				// Re-throw ambiguity errors, skip broken task files
				if (err instanceof Error && err.message.startsWith("Task ref")) throw err;
			}
		}
		if (matches.length === 0 && variantMiss) throw variantMiss;
		if (matches.length > 1) {
			const shown = matches.map((m) => `${m.task.id.slice(0, 8)} (${m.project.name})`).join(", ");
			throw new Error(`Task ref "${taskId}" matches ${matches.length} tasks across projects (${shown}). Pass --project to disambiguate.`);
		}
		return matches[0] ?? null;
	}

	for (const project of projects) {
		try {
			const tasks = await data.loadTasks(project);
			const task = findByIdPrefix(tasks, taskId, "task");
			if (task) return { project, task };
		} catch (err) {
			// Re-throw ambiguity errors, skip broken task files
			if (err instanceof Error && err.message.startsWith("Ambiguous")) throw err;
		}
	}
	return null;
}

/**
 * A socket param carrying a flat string map, or undefined when the caller sent
 * nothing. `devServer.start`'s `env` uses it; the handler sanitizes what comes
 * out, so this only has to reject shapes that are not a map at all.
 */
export function readEnvParam(params: Record<string, unknown>): Record<string, string> | undefined {
	const raw = params.env;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** Which dev server a `devServer.*` call names, and whether it means all of them. */
export function readServerParams(params: Record<string, unknown>): { server?: string; all?: boolean } {
	const server = typeof params.server === "string" && params.server ? params.server : undefined;
	return { ...(server ? { server } : {}), ...(params.all === true ? { all: true } : {}) };
}

/**
 * `opts.variantIndex` is `dev3 message --variant <i>` and only that: no other
 * command accepts the flag, so every other caller resolves exactly as before.
 */
export async function resolveTaskFromParams(
	params: Record<string, unknown>,
	opts?: { variantIndex?: number },
): Promise<{ project: Project; task: Task }> {
	const taskId = params.taskId as string;
	if (!taskId) throw new Error("taskId is required");
	const variantIndex = opts?.variantIndex;

	if (params.projectId) {
		const project = await data.getProject(params.projectId as string);
		const tasks = await data.loadTasks(project);
		const task = findTaskByRef(tasks, taskId, variantIndex);
		if (!task) throw await scopedTaskNotFoundError(taskId, project);
		return { project, task };
	}

	const found = await resolveTaskAcrossProjects(taskId, variantIndex);
	if (!found) throw taskNotFoundError(taskId);
	return found;
}

/** `dev3 message --variant <i>` off the wire; rejected here as well as in the CLI. */
export function messageVariantIndex(params: Record<string, unknown>): number | undefined {
	const raw = params.variantIndex;
	if (raw === undefined || raw === null) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`Invalid --variant "${String(raw)}": expected a non-negative integer index.`);
	}
	return value;
}

/**
 * Turn the CLI's `sourceTaskId` (set when `dev3 message` ran inside a worktree)
 * into the envelope metadata. Returns null for human-sent messages, an unknown
 * sender, or a task messaging itself — those stay verbatim.
 */
export async function resolveAgentMessageSource(
	params: Record<string, unknown>,
	targetTaskId: string,
): Promise<AgentMessageSource | null> {
	const sourceTaskId = typeof params.sourceTaskId === "string" ? params.sourceTaskId.trim() : "";
	if (!sourceTaskId) return null;
	let found: { project: Project; task: Task } | null = null;
	try {
		found = await resolveTaskAcrossProjects(sourceTaskId);
	} catch {
		return null; // ambiguous/broken sender ref — deliver the raw text instead
	}
	if (!found || found.task.id === targetTaskId) return null;
	// Whether `seq:<N>` still resolves on the SENDER's board decides the reply
	// address, and only the board can answer that (see agentReplyRef).
	const seqShared = await isSeqSharedOnBoard(found.project, found.task);
	return {
		taskId: found.task.id,
		seq: found.task.seq,
		variantIndex: found.task.variantIndex,
		seqShared,
		title: getTaskTitle(found.task),
		projectId: found.task.projectId,
		...(isCoordinatorTask(found.task) ? { role: "coordinator" as const } : {}),
	};
}

/**
 * Stamp the sending AGENT onto a source, from the pane and pid the CLI reported, so
 * a reply can reach that agent and no sibling. When none can be proven the source
 * says why instead, and the envelope then offers no reply command at all.
 */
export async function withSenderAgent(source: AgentMessageSource, params: Record<string, unknown>): Promise<AgentMessageSource> {
	let sender: Task | null = null;
	try {
		sender = (await resolveTaskAcrossProjects(source.taskId))?.task ?? null;
	} catch {
		sender = null;
	}
	if (!sender) return { ...source, agentUnavailable: "the sending task could not be read" };
	const identity = await captureSenderAgent(
		sender,
		typeof params.sourcePaneId === "string" ? params.sourcePaneId : null,
		typeof params.sourcePid === "number" ? params.sourcePid : null,
	);
	return identity.ok ? { ...source, agent: identity.author } : { ...source, agentUnavailable: identity.detail };
}

/** {@link seqIsShared} against a project's live task list; pessimistic if it cannot be read. */
async function isSeqSharedOnBoard(project: Project, task: Task): Promise<boolean> {
	try {
		return seqIsShared(task, await data.loadTasks(project));
	} catch {
		return task.variantIndex != null;
	}
}

/** The board's task list for seq-sharing checks, or null if it cannot be read. */
export async function loadBoardTasks(project: Project): Promise<Task[] | null> {
	try {
		return await data.loadTasks(project);
	} catch {
		return null;
	}
}
