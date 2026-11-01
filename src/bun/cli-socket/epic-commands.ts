import type { Epic } from "../../shared/types";
import { EPIC_CREATE_FORBIDDEN_PREFIX, isCoordinatorTask } from "../../shared/types";
import * as epicsData from "../epics-data";
import { getPushMessage } from "../rpc-handlers";
import { loadEpicMembers } from "../task-epics";
import type { Handler } from "./shared";
import { resolveTaskAcrossProjects } from "./task-resolution";

async function pushEpicsUpdated(): Promise<void> {
	getPushMessage()?.("epicsUpdated", { file: await epicsData.loadEpicsFile() });
}

/**
 * Only the user (no task context) and coordinators may grow the global
 * registry; any other agent attaches existing epics. Keeps a swarm of agents
 * from flooding everyone's pickers.
 */
async function assertMayCreateEpic(sourceTaskId: unknown): Promise<void> {
	const ref = typeof sourceTaskId === "string" ? sourceTaskId.trim() : "";
	if (!ref) return;
	const found = await resolveTaskAcrossProjects(ref);
	if (found && isCoordinatorTask(found.task)) return;
	throw new Error(
		`${EPIC_CREATE_FORBIDDEN_PREFIX}Only the user or a coordinator task can create an epic. Attach an existing one instead: "dev3 epic list", then "dev3 task update --epic <name|id>".`,
	);
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

export const epicHandlers: Record<string, Handler> = {
	/** Every epic with how many tasks it holds across all projects. */
	"epic.list": async () => {
		const [epics, members] = await Promise.all([epicsData.loadEpics(), loadEpicMembers()]);
		const counts = new Map<string, number>();
		for (const m of members) counts.set(m.epicId, (counts.get(m.epicId) ?? 0) + 1);
		return epics.map((epic) => ({ ...epic, taskCount: counts.get(epic.id) ?? 0 }));
	},

	"epic.create": async (params): Promise<Epic> => {
		await assertMayCreateEpic(params.sourceTaskId);
		const epic = await epicsData.createEpic(String(params.name ?? ""), stringParam(params, "color"));
		await pushEpicsUpdated();
		return epic;
	},

	"epic.update": async (params): Promise<Epic> => {
		const ref = stringParam(params, "epic");
		if (!ref) throw new Error("epic is required");
		const target = await epicsData.findEpic(ref);
		const archived = typeof params.archived === "boolean" ? params.archived : undefined;
		const epic = await epicsData.updateEpic(target.id, {
			name: stringParam(params, "name"),
			color: stringParam(params, "color"),
			archived,
		});
		await pushEpicsUpdated();
		return epic;
	},

	/** `dev3 tasks list --epic`: the epic's tasks from every project, every status. */
	"epic.tasks": async (params) => {
		const ref = stringParam(params, "epic");
		if (!ref) throw new Error("epic is required");
		const epic = await epicsData.findEpic(ref);
		return { epic, tasks: await loadEpicMembers(epic.id) };
	},
};
