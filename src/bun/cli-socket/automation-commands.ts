import { addAutomation, deleteAutomation, loadAutomations, updateAutomation } from "../automations-data";
import * as data from "../data";
import { getPushMessage } from "../rpc-handlers";
import type { Handler } from "./shared";
import { findByIdPrefix } from "./task-resolution";

export const automationHandlers: Record<string, Handler> = {

	"automations.list": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const project = await data.getProject(projectId);
		return loadAutomations(project);
	},

	"automations.show": async (params) => {
		const projectId = params.projectId as string;
		const automationId = params.automationId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!automationId) throw new Error("automationId is required");
		const project = await data.getProject(projectId);
		const automations = await loadAutomations(project);
		const automation = findByIdPrefix(automations, automationId, "automation");
		if (!automation) throw new Error(`Automation not found: ${automationId}`);
		return automation;
	},

	"automations.create": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const project = await data.getProject(projectId);
		const automation = await addAutomation(project, {
			name: params.name as string,
			prompt: params.prompt as string,
			rrule: params.rrule as string,
			timezone: params.timezone as string,
			agentId: (params.agentId as string | undefined) ?? null,
			configId: (params.configId as string | undefined) ?? null,
			...(params.enabled !== undefined ? { enabled: Boolean(params.enabled) } : {}),
			...(params.catchUp !== undefined ? { catchUp: params.catchUp as "skip" | "runOnce" } : {}),
		});
		getPushMessage()?.("automationsUpdated", { projectId: project.id });
		return automation;
	},

	"automations.update": async (params) => {
		const projectId = params.projectId as string;
		const automationId = params.automationId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!automationId) throw new Error("automationId is required");
		const project = await data.getProject(projectId);
		const automations = await loadAutomations(project);
		const automation = findByIdPrefix(automations, automationId, "automation");
		if (!automation) throw new Error(`Automation not found: ${automationId}`);
		const updates: Record<string, unknown> = {};
		for (const key of ["name", "prompt", "rrule", "timezone", "agentId", "configId", "enabled", "catchUp"] as const) {
			if (params[key] !== undefined) updates[key] = params[key];
		}
		const updated = await updateAutomation(project, automation.id, updates);
		getPushMessage()?.("automationsUpdated", { projectId: project.id });
		return updated;
	},

	"automations.delete": async (params) => {
		const projectId = params.projectId as string;
		const automationId = params.automationId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!automationId) throw new Error("automationId is required");
		const project = await data.getProject(projectId);
		const automations = await loadAutomations(project);
		const automation = findByIdPrefix(automations, automationId, "automation");
		if (!automation) throw new Error(`Automation not found: ${automationId}`);
		await deleteAutomation(project, automation.id);
		getPushMessage()?.("automationsUpdated", { projectId: project.id });
		return { deleted: automation.id };
	},

	"automations.run": async (params) => {
		const projectId = params.projectId as string;
		const automationId = params.automationId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!automationId) throw new Error("automationId is required");
		const project = await data.getProject(projectId);
		const automations = await loadAutomations(project);
		const automation = findByIdPrefix(automations, automationId, "automation");
		if (!automation) throw new Error(`Automation not found: ${automationId}`);
		// Lazy import: the scheduler pulls in the full task-creation pipeline
		// (worktree/PTY/Electrobun), which must not load at module-import time
		// for this file (unit tests import it with the pipeline mocked out).
		const { runAutomationNow } = await import("../automations-scheduler");
		return runAutomationNow(project, automation);
	},
};
