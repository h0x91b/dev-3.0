import { mkdir, readFile } from "node:fs/promises";
import type { Automation, AutomationDraft, AutomationRun, Project } from "../shared/types";
import { MAX_AUTOMATION_RUNS_KEPT } from "../shared/types";
import { RRuleParseError, isValidTimezone, nextOccurrence, parseRRule } from "../shared/rrule";
import { atomicWriteFile } from "./data";
import { withFileLock } from "./file-lock";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { projectSlug } from "./git";

const log = createLogger("automations-data");

/**
 * Automations live in `~/.dev3.0/data/<slug>/automations.json` — a NEW sibling
 * of tasks.json (the rule-5 additive parallel-path pattern from AGENTS.md):
 * older app versions never read the file, nothing existing is moved or renamed.
 */
export function automationsFile(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/automations.json`;
}

export class AutomationValidationError extends Error {
	override name = "AutomationValidationError";
}

/** Validate draft fields that are present; throws {@link AutomationValidationError}. */
export function validateAutomationDraft(draft: Partial<AutomationDraft>): void {
	if (draft.name !== undefined && !draft.name.trim()) {
		throw new AutomationValidationError("Automation name must not be empty");
	}
	if (draft.prompt !== undefined && !draft.prompt.trim()) {
		throw new AutomationValidationError("Automation prompt must not be empty");
	}
	if (draft.rrule !== undefined) {
		try {
			parseRRule(draft.rrule);
		} catch (err) {
			if (err instanceof RRuleParseError) throw new AutomationValidationError(`Invalid schedule: ${err.message}`);
			throw err;
		}
	}
	if (draft.timezone !== undefined && !isValidTimezone(draft.timezone)) {
		throw new AutomationValidationError(`Invalid timezone: "${draft.timezone}" (use an IANA name like Europe/Berlin)`);
	}
	if (draft.catchUp !== undefined && draft.catchUp !== "skip" && draft.catchUp !== "runOnce") {
		throw new AutomationValidationError(`Invalid catch-up policy: "${draft.catchUp}" (skip | runOnce)`);
	}
}

/** Compute the persisted nextRunAt for an automation (null when disabled). */
export function computeNextRunAt(automation: Pick<Automation, "rrule" | "timezone" | "enabled" | "createdAt">, after: Date = new Date()): string | null {
	if (!automation.enabled) return null;
	try {
		const spec = parseRRule(automation.rrule);
		const next = nextOccurrence(spec, after, automation.timezone, new Date(automation.createdAt));
		return next ? next.toISOString() : null;
	} catch (err) {
		log.warn("computeNextRunAt failed (rule unparseable)", { rrule: automation.rrule, error: String(err) });
		return null;
	}
}

async function rawLoadAutomations(project: Project): Promise<Automation[]> {
	const file = automationsFile(project);
	try {
		const items = JSON.parse(await readFile(file, "utf8")) as Automation[];
		for (const a of items) {
			if ((a as any).runs === undefined) a.runs = [];
			if ((a as any).catchUp === undefined) a.catchUp = "skip";
			if ((a as any).enabled === undefined) a.enabled = true;
			if ((a as any).nextRunAt === undefined) a.nextRunAt = null;
			if ((a as any).agentId === undefined) a.agentId = null;
			if ((a as any).configId === undefined) a.configId = null;
		}
		return items;
	} catch (err: any) {
		if (err.code === "ENOENT") return [];
		log.error("Failed to load automations", { projectId: project.id, error: String(err) });
		return [];
	}
}

async function rawSaveAutomations(project: Project, items: Automation[]): Promise<void> {
	const file = automationsFile(project);
	const dir = file.slice(0, file.lastIndexOf("/"));
	await mkdir(dir, { recursive: true });
	await atomicWriteFile(file, JSON.stringify(items, null, 2));
}

export async function loadAutomations(project: Project): Promise<Automation[]> {
	return rawLoadAutomations(project);
}

export async function getAutomation(project: Project, automationId: string): Promise<Automation> {
	const items = await rawLoadAutomations(project);
	const found = items.find((a) => a.id === automationId || a.id.startsWith(automationId));
	if (!found) throw new Error(`Automation not found: ${automationId}`);
	return found;
}

export async function addAutomation(project: Project, draft: AutomationDraft): Promise<Automation> {
	validateAutomationDraft(draft);
	if (!draft.name?.trim()) throw new AutomationValidationError("Automation name is required");
	if (!draft.prompt?.trim()) throw new AutomationValidationError("Automation prompt is required");
	if (!draft.rrule) throw new AutomationValidationError("Automation schedule (rrule) is required");
	if (!draft.timezone) throw new AutomationValidationError("Automation timezone is required");

	const file = automationsFile(project);
	return withFileLock(file, async () => {
		const items = await rawLoadAutomations(project);
		const now = new Date().toISOString();
		const automation: Automation = {
			id: crypto.randomUUID(),
			projectId: project.id,
			name: draft.name.trim(),
			prompt: draft.prompt,
			rrule: draft.rrule,
			timezone: draft.timezone,
			agentId: draft.agentId ?? null,
			configId: draft.configId ?? null,
			enabled: draft.enabled ?? true,
			catchUp: draft.catchUp ?? "skip",
			createdAt: now,
			updatedAt: now,
			nextRunAt: null,
			runs: [],
		};
		automation.nextRunAt = computeNextRunAt(automation);
		items.push(automation);
		await rawSaveAutomations(project, items);
		log.info("Automation created", { projectId: project.id, automationId: automation.id, name: automation.name, nextRunAt: automation.nextRunAt });
		return automation;
	});
}

export async function updateAutomation(
	project: Project,
	automationId: string,
	updates: Partial<AutomationDraft>,
): Promise<Automation> {
	validateAutomationDraft(updates);
	const file = automationsFile(project);
	return withFileLock(file, async () => {
		const items = await rawLoadAutomations(project);
		const idx = items.findIndex((a) => a.id === automationId);
		if (idx === -1) throw new Error(`Automation not found: ${automationId}`);
		const prev = items[idx];
		const next: Automation = {
			...prev,
			...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
			...(updates.prompt !== undefined ? { prompt: updates.prompt } : {}),
			...(updates.rrule !== undefined ? { rrule: updates.rrule } : {}),
			...(updates.timezone !== undefined ? { timezone: updates.timezone } : {}),
			...(updates.agentId !== undefined ? { agentId: updates.agentId } : {}),
			...(updates.configId !== undefined ? { configId: updates.configId } : {}),
			...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
			...(updates.catchUp !== undefined ? { catchUp: updates.catchUp } : {}),
			updatedAt: new Date().toISOString(),
		};
		const scheduleChanged = next.rrule !== prev.rrule || next.timezone !== prev.timezone || next.enabled !== prev.enabled;
		if (scheduleChanged) next.nextRunAt = computeNextRunAt(next);
		items[idx] = next;
		await rawSaveAutomations(project, items);
		log.info("Automation updated", { projectId: project.id, automationId, nextRunAt: next.nextRunAt });
		return next;
	});
}

export async function deleteAutomation(project: Project, automationId: string): Promise<void> {
	const file = automationsFile(project);
	return withFileLock(file, async () => {
		const items = await rawLoadAutomations(project);
		const filtered = items.filter((a) => a.id !== automationId);
		if (filtered.length === items.length) throw new Error(`Automation not found: ${automationId}`);
		await rawSaveAutomations(project, filtered);
		log.info("Automation deleted", { projectId: project.id, automationId });
	});
}

/**
 * Append run entries (newest first, capped) and/or advance nextRunAt — the one
 * mutator the scheduler uses. Runs under the file lock so a concurrent CRUD
 * edit from the UI can never be lost.
 */
export async function recordAutomationRuns(
	project: Project,
	automationId: string,
	runs: AutomationRun[],
	updates?: { nextRunAt?: string | null },
): Promise<Automation> {
	const file = automationsFile(project);
	return withFileLock(file, async () => {
		const items = await rawLoadAutomations(project);
		const idx = items.findIndex((a) => a.id === automationId);
		if (idx === -1) throw new Error(`Automation not found: ${automationId}`);
		const prev = items[idx];
		items[idx] = {
			...prev,
			runs: [...runs, ...prev.runs].slice(0, MAX_AUTOMATION_RUNS_KEPT),
			...(updates && "nextRunAt" in updates ? { nextRunAt: updates.nextRunAt ?? null } : {}),
			updatedAt: new Date().toISOString(),
		};
		await rawSaveAutomations(project, items);
		return items[idx];
	});
}
