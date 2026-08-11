/**
 * Re-assert dev3's Claude hooks right before a prompt is typed into an agent.
 *
 * Hooks are installed once at launch, but `.claude/settings.local.json` is not
 * ours: Claude Code rewrites the whole file from its own in-memory snapshot when
 * the user answers a permission or `.mcp.json` prompt, and an MCP server or a
 * user hook can rewrite it too. A snapshot taken before our hooks landed puts
 * the file back without them, and the task then silently stops moving between
 * columns for the rest of the session.
 *
 * Sending a prompt is the one moment that is both frequent and free: the write
 * is skipped entirely when the file already carries our hooks, so the steady
 * state costs one read.
 *
 * Claude only. Codex reads its dev3 hooks from a `-c hooks=...` override fixed at
 * launch, so rewriting `.codex/hooks.json` mid-session would change nothing.
 */

import type { AgentHooksIntegration, Task } from "../shared/types";
import { createLogger } from "./logger";
import { getHooksAdapter } from "../shared/agent-adapters/registry";
import { writeClaudeHooks } from "../shared/agent-hooks";
import { findConfig, getAllAgents } from "./agents";
import { getProject } from "./data";

const log = createLogger("agent-hooks-refresh");

/** The base command + declared hook family of the task's agent, or null if unknown. */
async function resolveTaskAgentHooks(
	task: Task,
): Promise<{ baseCommand: string; integration?: AgentHooksIntegration } | null> {
	if (!task.agentId) return null;
	const agent = (await getAllAgents()).find((a) => a.id === task.agentId);
	if (!agent) return null;
	const baseCommand = findConfig(agent, task.configId)?.baseCommandOverride || agent.baseCommand;
	if (!baseCommand) return null;
	return { baseCommand, integration: agent.hooksIntegration };
}

/**
 * Re-install the Claude hooks for `task` if they are missing. Never throws and
 * never blocks the prompt: a failure here must not swallow the user's message.
 */
export async function refreshClaudeHooksForTask(task: Task): Promise<void> {
	try {
		if (!task.worktreePath) return;

		const resolved = await resolveTaskAgentHooks(task);
		if (!resolved) return;

		const spec = getHooksAdapter(resolved.baseCommand, resolved.integration).hooksSpec();
		if (spec?.kind !== "claude") return;

		const project = await getProject(task.projectId);
		const changed = writeClaudeHooks(task.worktreePath, {
			stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
		});
		if (changed) {
			log.info("Claude hooks were missing before a prompt and got reinstalled", {
				taskId: task.id,
				worktreePath: task.worktreePath,
			});
		}
	} catch (err) {
		log.warn("refreshClaudeHooksForTask failed (non-fatal)", {
			taskId: task.id,
			error: String(err),
		});
	}
}
