import type { Automation, AutomationDraft } from "../../shared/types";
import * as data from "../data";
import {
	addAutomation,
	deleteAutomation as deleteAutomationData,
	getAutomation,
	loadAutomations,
	updateAutomation as updateAutomationData,
} from "../automations-data";
import { runAutomationNow as runNow } from "../automations-scheduler";
import { getPushMessage, log } from "./shared";

async function listAutomations(params: { projectId: string }): Promise<Automation[]> {
	const project = await data.getProject(params.projectId);
	return loadAutomations(project);
}

async function createAutomation(params: { projectId: string } & AutomationDraft): Promise<Automation> {
	log.info("→ createAutomation", { projectId: params.projectId, name: params.name });
	const project = await data.getProject(params.projectId);
	const { projectId: _projectId, ...draft } = params;
	const automation = await addAutomation(project, draft);
	getPushMessage()?.("automationsUpdated", { projectId: project.id });
	return automation;
}

async function updateAutomation(params: { projectId: string; automationId: string } & Partial<AutomationDraft>): Promise<Automation> {
	log.info("→ updateAutomation", { projectId: params.projectId, automationId: params.automationId });
	const project = await data.getProject(params.projectId);
	const { projectId: _projectId, automationId, ...updates } = params;
	const automation = await updateAutomationData(project, automationId, updates);
	getPushMessage()?.("automationsUpdated", { projectId: project.id });
	return automation;
}

async function deleteAutomation(params: { projectId: string; automationId: string }): Promise<void> {
	log.info("→ deleteAutomation", { projectId: params.projectId, automationId: params.automationId });
	const project = await data.getProject(params.projectId);
	await deleteAutomationData(project, params.automationId);
	getPushMessage()?.("automationsUpdated", { projectId: project.id });
}

async function runAutomationNow(params: { projectId: string; automationId: string }): Promise<{ taskId: string }> {
	log.info("→ runAutomationNow", { projectId: params.projectId, automationId: params.automationId });
	const project = await data.getProject(params.projectId);
	const automation = await getAutomation(project, params.automationId);
	return runNow(project, automation);
}

export const automationsHandlers = {
	listAutomations,
	createAutomation,
	updateAutomation,
	deleteAutomation,
	runAutomationNow,
};
