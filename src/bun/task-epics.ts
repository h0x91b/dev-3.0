import type { Epic, EpicMember, Project, Task } from "../shared/types";
import { EPIC_REF_INVALID_PREFIX } from "../shared/types";
import * as data from "./data";
import { findEpic, getEpicById } from "./epics-data";
import { allBoards, lineageNode } from "./task-lineage";
import { createLogger } from "./logger";

const log = createLogger("task-epics");

/**
 * Every task on every board that belongs to an epic — the cross-project read
 * behind `dev3 tasks list --epic` and the board's "+N in other projects".
 * Only members are returned, so the payload stays small.
 */
export async function loadEpicMembers(epicId?: string): Promise<EpicMember[]> {
	const members: EpicMember[] = [];
	for (const { project, tasks } of await allBoards()) {
		const groupSizes = new Map<string, number>();
		for (const task of tasks) if (task.groupId) groupSizes.set(task.groupId, (groupSizes.get(task.groupId) ?? 0) + 1);
		for (const task of tasks) {
			if (!task.epicId || (epicId && task.epicId !== epicId)) continue;
			members.push({ ...lineageNode(task, project, groupSizes), epicId: task.epicId });
		}
	}
	return members;
}

/**
 * The epic a new task gets: an explicit `--epic` wins, `--no-epic` forces none,
 * otherwise the creator task's epic unless it is archived. An unresolvable
 * creator means no epic and never fails the create.
 */
/**
 * An archived epic takes no new member; a task already in it may keep it.
 * Throws the CLI-coded error otherwise.
 */
export function assertEpicAttachable(epic: Epic, task: Pick<Task, "epicId"> | null): void {
	if (!epic.archived || task?.epicId === epic.id) return;
	throw new Error(`${EPIC_REF_INVALID_PREFIX}Epic "${epic.name}" is archived; tasks cannot join it. Unarchive it first with "dev3 epic unarchive ${epic.id.slice(0, 8)}".`);
}

export async function epicForNewTask(params: { epic?: unknown; noEpic?: unknown; creator: Task | null }): Promise<string | undefined> {
	if (params.noEpic === true) return undefined;
	if (typeof params.epic === "string" && params.epic.trim()) {
		const epic = await findEpic(params.epic);
		assertEpicAttachable(epic, null);
		return epic.id;
	}
	const inherited = params.creator?.epicId;
	if (!inherited) return undefined;
	try {
		const epic = await getEpicById(inherited);
		return epic && !epic.archived ? epic.id : undefined;
	} catch (err) {
		log.warn("Epic registry unreadable; the new task gets no epic", { error: String(err) });
		return undefined;
	}
}

/** Set or clear one task's epic. Never touches any other task — no propagation. */
export async function setTaskEpic(project: Project, taskId: string, epicId: string | null): Promise<Task> {
	return data.updateTask(project, taskId, { epicId: epicId ?? undefined });
}
