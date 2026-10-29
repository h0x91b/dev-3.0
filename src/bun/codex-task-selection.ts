import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CodingAgent, PaneSessionEntry, Project, Task } from "../shared/types";
import { hasGitWorkflow } from "../shared/types";
import { agentKey } from "../shared/agent-adapters/families";
import * as agents from "./agents";
import * as data from "./data";
import * as git from "./git";
import * as repoConfig from "./repo-config";
import { codexAccountIdForHome } from "./agent-accounts";
import { selectCodexConversations, type CodexSelectionIntent } from "./codex-resume-home";

/** A pane is Codex when its resolved agent is, not only when its command string says so. */
export function isCodexPane(pane: PaneSessionEntry, allAgents: CodingAgent[]): boolean {
	const agent = pane.agentId ? allAgents.find((entry) => entry.id === pane.agentId) : undefined;
	if (agent) {
		const config = agents.findConfig(agent, pane.configId);
		return agentKey(config?.baseCommandOverride || agent.baseCommand, agent.agentFamily) === "codex";
	}
	return agentKey(pane.agentCmd, pane.agentFamily ?? undefined) === "codex";
}

/** Where resume looks for a Codex conversation, besides the managed account stores. */
export async function configuredCodexHomes(project: Project, task: Task, agent: CodingAgent | undefined, configId: string | null | undefined): Promise<string[]> {
	const config = agent ? agents.findConfig(agent, configId) : undefined;
	const projectEnv = await repoConfig.resolveProjectEnv(project, task.worktreePath!, { foreignCode: task.foreignCode });
	return [config?.envVars?.CODEX_HOME, projectEnv.CODEX_HOME, process.env.CODEX_HOME]
		.filter((value): value is string => !!value)
		.map((value) => resolve(task.worktreePath!, value));
}

/**
 * The folder whose conversations may be scanned: only a git task's managed
 * worktree, whose path carries the task id. An Operations folder or a project
 * folder can be shared by several tasks, so matching its cwd proves nothing.
 */
function scanWorktree(project: Project, task: Task): string | null {
	if (!hasGitWorkflow(project) || !task.worktreePath) return null;
	return task.worktreePath === `${git.taskDir(project, task)}/worktree` ? task.worktreePath : null;
}

async function folderBirthMs(path: string): Promise<number | null> {
	try {
		const born = (await stat(path)).birthtimeMs;
		return Number.isFinite(born) && born > 0 ? born : null;
	} catch {
		return null;
	}
}

export interface CodexPaneChoice { sessionId: string; codexHome: string }

/**
 * Choose the conversation of every Codex pane in `panes` (indices into it),
 * from one snapshot, and claim the choices on the task before anything launches.
 * Throws the refusal reason when any pane cannot be chosen safely.
 *
 * Only for relaunching EVERY pane passed: all are treated as not live. So it
 * refuses `automatic-recovery`, which may run beside live panes: that caller uses
 * `selectCodexConversations` with each running or unknown pane `live: true`.
 */
export async function chooseTaskCodexConversations(
	project: Project,
	task: Task,
	panes: PaneSessionEntry[],
	intent: Exclude<CodexSelectionIntent, "automatic-recovery">,
	/** `onDisk`: the panes stored now, when `panes` was rebuilt (a lost pane record). */
	options: { persist: boolean; onDisk?: PaneSessionEntry[] },
): Promise<Map<number, CodexPaneChoice>> {
	if ((intent as CodexSelectionIntent) === "automatic-recovery") {
		throw new Error("chooseTaskCodexConversations treats every pane as relaunched; automatic recovery must call selectCodexConversations with real pane liveness.");
	}
	const allAgents = await agents.getAllAgents();
	const codexIndices = panes.flatMap((pane, index) => (isCodexPane(pane, allAgents) ? [index] : []));
	const choices = new Map<number, CodexPaneChoice>();
	if (!codexIndices.length || !task.worktreePath) return choices;

	const homes = new Set<string>();
	for (const index of codexIndices) {
		const agent = allAgents.find((entry) => entry.id === panes[index].agentId);
		for (const configured of await configuredCodexHomes(project, task, agent, panes[index].configId)) homes.add(configured);
	}
	const selections = await selectCodexConversations({
		intent,
		scanWorktree: scanWorktree(project, task),
		// Every pane here is being relaunched, so none of them is live.
		panes: codexIndices.map((index) => ({ sessionId: panes[index].sessionId, accountId: panes[index].accountId, live: false, resumeNow: true })),
		runBoundary: {
			lifecycleStartedAt: task.lifecycleStartedAt,
			worktreeBirthMs: await folderBirthMs(task.worktreePath),
			floorAt: task.codexScanFloorAt,
		},
		additionalHomes: [...homes],
	});
	const refusal = selections.find((selection) => selection.kind === "none" || selection.kind === "ambiguous" || selection.kind === "account-mismatch");
	if (refusal && "reason" in refusal) throw new Error(`Cannot resume Codex: ${refusal.reason}`);
	selections.forEach((selection, i) => {
		if (selection.kind === "selected") choices.set(codexIndices[i], { sessionId: selection.sessionId, codexHome: selection.codexHome });
	});
	if (options.persist) await claimChoices(project, task, options.onDisk ?? panes, panes, choices);
	return choices;
}

/**
 * Record the chosen ids only if no pane changed since the snapshot, so a second
 * app instance choosing at the same time fails instead of doubling a conversation.
 */
async function claimChoices(project: Project, task: Task, expected: PaneSessionEntry[], snapshot: PaneSessionEntry[], choices: Map<number, CodexPaneChoice>): Promise<void> {
	const { result } = await data.updateTaskWith(project, task.id, (current) => {
		const stored = current.sessionState?.panes ?? [];
		const unchanged = stored.length === expected.length && expected.every((pane, i) => stored[i]?.sessionId === pane.sessionId);
		if (!unchanged) return { updates: {}, result: false };
		const next = (expected === snapshot ? stored : snapshot).map((pane, i) => {
			const choice = choices.get(i);
			if (!choice || choice.sessionId === pane.sessionId) return pane;
			return { ...pane, sessionId: choice.sessionId, accountId: codexAccountIdForHome(choice.codexHome) ?? null };
		});
		return { updates: { sessionState: { panes: next } }, result: true };
	});
	if (!result) throw new Error("Cannot resume Codex: the task's panes changed while its conversations were being chosen. Try again.");
}
