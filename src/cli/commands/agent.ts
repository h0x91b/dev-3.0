import type { CodingAgent } from "../../shared/types";
import type { SpawnAgentResult } from "../../shared/conversation-handoff-model";
import { CLI_EXIT_CODE_LAUNCH_DECLINED } from "../../shared/cli-exit-codes";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { launchApprovalTimeoutMs } from "../launch-approval";
import { exitError, exitUsage } from "../output";
import { sendRequest } from "../socket-client";
import { readStdin } from "../stdin";
import { singleTextInput } from "../text-input";

export async function handleAgent(subcommand: string | undefined, args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	if (subcommand === "list") {
		rejectUnknownFlags(args, ["json"]);
		const resp = await sendRequest(socketPath, "agent.list", {});
		if (!resp.ok) exitError(resp.error || "Failed to list agents");
		const agents = resp.data as CodingAgent[];
		if ("json" in args.flags) {
			process.stdout.write(`${JSON.stringify(agents, null, 2)}\n`);
		} else {
			for (const agent of agents) {
				process.stdout.write(`${agent.id}  ${agent.name}\n`);
				for (const config of agent.configurations) process.stdout.write(`  ${config.id}  ${config.name}\n`);
			}
		}
		return;
	}
	if (subcommand !== "spawn") return exitUsage("Usage: dev3 agent list [--json] | dev3 agent spawn [--task <id>] [--agent <id>] [--config <id>] [--prompt <text>|-] [--handoff] [--json]");
	rejectUnknownFlags(args, ["task", "task-id", "project", "agent", "config", "prompt", "handoff", "json"]);
	if (args.positional.length) return exitUsage("agent spawn takes flags, not positional arguments");
	const rawTask = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTask) return exitUsage("No task in context — pass --task <id>.");
	if (args.flags.config && !args.flags.agent) return exitUsage("--config requires --agent (see dev3 agent list).");
	let prompt = singleTextInput(args, "prompt");
	if (prompt === "-") prompt = await readStdin();
	if (prompt !== undefined && !prompt.trim()) return exitUsage("--prompt must not be empty.");
	const projectId = resolveProjectId(args.flags.project, context);
	const params = {
		taskId: expandShortId(rawTask, context),
		...(projectId ? { projectId } : {}),
		...(context?.taskId ? { sourceTaskId: context.taskId } : {}),
		agentId: args.flags.agent ?? null,
		configId: args.flags.config ?? null,
		...(prompt !== undefined ? { prompt } : {}),
		handoff: "handoff" in args.flags,
	};
	let resp;
	try {
		resp = await sendRequest(socketPath, "agent.spawn", params, { timeoutMs: await launchApprovalTimeoutMs(socketPath) });
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Socket timeout")) {
			return exitError("Timed out waiting for the launch", "The approval dialog may still be open; a later approval can still launch the agent. Do not blindly retry.");
		}
		throw err;
	}
	if (!resp.ok) return exitError(resp.error || "Failed to spawn agent");
	const result = resp.data as { approved: boolean; stale?: boolean; spawn?: SpawnAgentResult };
	if (!result.approved) return exitError(result.stale ? "The target task's run ended before approval" : "User declined the launch request", "No agent was started.", CLI_EXIT_CODE_LAUNCH_DECLINED);
	if (!result.spawn?.paneId) return exitError("Unexpected response to agent spawn");
	process.stdout.write("json" in args.flags ? `${JSON.stringify(result.spawn, null, 2)}\n` : `Spawned agent ${result.spawn.agentId ?? "default"} in pane ${result.spawn.paneId} (${result.spawn.backend}).\n`);
}
