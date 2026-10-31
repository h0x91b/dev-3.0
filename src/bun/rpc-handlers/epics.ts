import type { Epic, EpicMember, EpicsFile, Task } from "../../shared/types";
import * as data from "../data";
import * as epicsData from "../epics-data";
import { loadEpicMembers, setTaskEpic as writeTaskEpic } from "../task-epics";
import { getPushMessage } from "./shared";

/** Broadcast the fresh registry after any mutation so every window stays in sync. */
async function pushEpicsUpdated(): Promise<void> {
	getPushMessage()?.("epicsUpdated", { file: await epicsData.loadEpicsFile() });
}

async function getEpics(_params: Record<string, never>): Promise<EpicsFile> {
	return epicsData.loadEpicsFile();
}

/** Every task in any epic, across all projects — for the chip filter's "+N in other projects". */
async function getEpicMembers(_params: Record<string, never>): Promise<EpicMember[]> {
	return loadEpicMembers();
}

async function createEpic(params: { name: string; color?: string }): Promise<Epic> {
	const epic = await epicsData.createEpic(params.name, params.color);
	await pushEpicsUpdated();
	return epic;
}

async function updateEpic(params: { epicId: string; name?: string; color?: string; archived?: boolean }): Promise<Epic> {
	const { epicId, ...changes } = params;
	const epic = await epicsData.updateEpic(epicId, changes);
	await pushEpicsUpdated();
	return epic;
}

/** Set or clear one task's epic. Archived epics may stay but never be newly picked. */
async function setTaskEpic(params: { projectId: string; taskId: string; epicId: string | null }): Promise<Task> {
	if (params.epicId) {
		const epic = await epicsData.getEpicById(params.epicId);
		if (!epic) throw new Error(`Epic not found: ${params.epicId}`);
	}
	const project = await data.getProject(params.projectId);
	const task = await writeTaskEpic(project, params.taskId, params.epicId);
	getPushMessage()?.("taskUpdated", { projectId: project.id, task });
	return task;
}

export const epicsHandlers = {
	getEpics,
	getEpicMembers,
	createEpic,
	updateEpic,
	setTaskEpic,
};
