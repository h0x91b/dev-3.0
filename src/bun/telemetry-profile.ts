/**
 * Gathers the coarse install facts the renderer reports to GA4.
 *
 * Nothing here reads a project name, a repo path, a task title or a branch — the
 * counts are bucketed by {@link src/shared/telemetry-profile} before they are
 * returned, and every other field is a fixed vocabulary. See the telemetry rules
 * in AGENTS.md.
 *
 * Every lookup is individually fault-tolerant: analytics must never be the reason
 * a launch fails, so a failing probe yields `"unknown"` and the rest still ships.
 */

import { release } from "node:os";
import { loadProjects, loadTasks, loadVirtualProjects, newTaskTerminalBackend } from "./data";
import { readNewTaskTerminalBackendPreference } from "./terminal-backend-preference";
import { getAllAgents } from "./agents";
import { loadSettings } from "./settings";
import { detectRosetta } from "./rosetta";
import { resolveInstallMethod } from "./self-update";
import { resolveInstallDate } from "./install-date";
import { createLogger } from "./logger";
import {
	cpuArchLabel,
	daysSince,
	installAgeBucket,
	osVersionFromKernel,
	projectCountBucket,
	taskCountBucket,
	type TelemetryProfile,
} from "../shared/telemetry-profile";

const log = createLogger("telemetry-profile");

const UNKNOWN = "unknown";

async function safe<T>(what: string, fn: () => Promise<T> | T, fallback: T): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		log.warn(`could not resolve ${what}`, { error: String(err) });
		return fallback;
	}
}

/** Name of the agent preset new tasks launch with, resolved the way a launch resolves it. */
async function resolveDefaultAgentName(): Promise<string> {
	const [settings, agents] = await Promise.all([loadSettings(), getAllAgents()]);
	const agent =
		agents.find((a) => a.id === settings.defaultAgentId) ??
		agents.find((a) => a.isDefault) ??
		agents[0];
	return agent?.name ?? UNKNOWN;
}

/** Projects and their tasks, counted across real and virtual boards. */
async function countProjectsAndTasks(): Promise<{ projects: number; tasks: number }> {
	const projects = [...(await loadProjects()), ...(await loadVirtualProjects())];
	let tasks = 0;
	for (const project of projects) {
		try {
			tasks += (await loadTasks(project)).length;
		} catch {
			// One unreadable board must not void the whole count.
		}
	}
	return { projects: projects.length, tasks };
}

/** What a task created right now would be stamped with; absent still means tmux. */
function resolveTerminalBackend(): string {
	return newTaskTerminalBackend(process.platform, readNewTaskTerminalBackendPreference()) ?? "tmux";
}

/** Collect the profile. Never throws. */
export async function collectTelemetryProfile(nowMs: number = Date.now()): Promise<TelemetryProfile> {
	const [counts, defaultAgent, terminalBackend, installedAt] = await Promise.all([
		safe("project/task counts", countProjectsAndTasks, { projects: 0, tasks: 0 }),
		safe("default agent", resolveDefaultAgentName, UNKNOWN),
		safe("terminal backend", () => resolveTerminalBackend(), UNKNOWN),
		safe("install date", () => resolveInstallDate(nowMs), nowMs),
	]);

	return {
		cpuArch: await safe("cpu arch", () => cpuArchLabel(process.arch, detectRosetta()), process.arch),
		osVersion: await safe("os version", () => osVersionFromKernel(process.platform, release()), ""),
		installType: await safe("install type", resolveInstallMethod, UNKNOWN),
		terminalBackend,
		defaultAgent,
		projectCountBucket: projectCountBucket(counts.projects),
		taskCountBucket: taskCountBucket(counts.tasks),
		installAgeBucket: installAgeBucket(daysSince(installedAt, nowMs)),
	};
}
