import type { AgentConfiguration, CodingAgent } from "../../shared/types";
import { formatTaskRef } from "../../shared/task-refs";
import type { SpawnAgentResult } from "../../shared/conversation-handoff-model";
import type { CliResumeOutcome, ResumePaneReport } from "../../shared/agent-resume";
import { CLI_EXIT_CODE_LAUNCH_DECLINED, CLI_EXIT_CODE_RESUME_ALREADY_RUNNING, CLI_EXIT_CODE_RESUME_UNAVAILABLE } from "../../shared/cli-exit-codes";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { launchApprovalTimeoutMs } from "../launch-approval";
import { exitError, exitUsage } from "../output";
import { sendRequest } from "../socket-client";
import { readStdin } from "../stdin";
import { singleTextInput } from "../text-input";
import { exitOnSenderError, readSenderFlag } from "./sender";

export async function handleAgent(subcommand: string | undefined, args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	if (subcommand === "list") {
		rejectUnknownFlags(args, ["json"]);
		const resp = await sendRequest(socketPath, "agent.list", {});
		if (!resp.ok) exitError(resp.error || "Failed to list agents");
		const agents = resp.data as Array<Pick<CodingAgent, "id" | "name"> & { configurations: Pick<AgentConfiguration, "id" | "name" | "model" | "effort">[] }>;
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
	if (subcommand === "resume") return handleResume(args, socketPath, context);
	if (subcommand === "aws-profiles") return handleAwsProfiles(args, socketPath);
	if (subcommand !== "spawn") return exitUsage("Usage: dev3 agent list [--json] | dev3 agent aws-profiles list|set ... | dev3 agent spawn [--task <id>] [--agent <id>] [--config <id>] [--prompt <text>|-] [--handoff] [--json] | dev3 agent resume [--task <id>] [--allow-agent-latest] [--as-sender <id>] [--json]");
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
	// The agent is already running here; a missing pane id must not read as a failure worth retrying.
	if (!result.spawn) return exitError("Unexpected response to agent spawn");
	process.stdout.write("json" in args.flags ? `${JSON.stringify(result.spawn, null, 2)}\n` : `Spawned agent ${result.spawn.agentId ?? "default"} in pane ${result.spawn.paneId || "(id unknown)"} (${result.spawn.backend}).\n`);
}

function describePane(pane: ResumePaneReport): string {
	const who = `${pane.agentId ?? "default agent"}${pane.configId ? ` / ${pane.configId}` : ""}`;
	const conversation = pane.mode === "fresh" ? "cannot resume — would start over"
		: pane.sessionId ? `conversation ${pane.sessionId} (${pane.mode})`
		: pane.mode === "fresh-session" ? "new conversation — none of its own survives (fresh-session)"
		: "harness's own latest conversation";
	const where = pane.status === "resumed" ? `pane ${pane.paneId ?? "(id not captured yet)"}` : pane.detail ? `${pane.status}: ${pane.detail}` : "not resumed";
	return `  #${pane.index}${pane.index === 0 ? " main " : " extra"}  ${who}  ${conversation}  ${where}\n`;
}

/** Same managed path as the terminal's Resume Session button — never a reset or a new worktree, and never the task brief again. */
async function handleResume(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "allow-agent-latest", "as-sender", "json"]);
	if (args.positional.length) return exitUsage("agent resume takes flags, not positional arguments");
	// A sender's resume goes through the same approval dialog an agent's does.
	const asSender = readSenderFlag(args, "as-sender", context);
	const rawTask = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTask) return exitUsage("No task in context — pass --task <id>.");
	const json = "json" in args.flags;
	const projectId = resolveProjectId(args.flags.project, context);
	const params = {
		taskId: expandShortId(rawTask, context),
		...(projectId ? { projectId } : {}),
		...(context?.taskId ? { sourceTaskId: context.taskId } : {}),
		...(asSender ? { asSender } : {}),
		allowAgentLatest: "allow-agent-latest" in args.flags,
	};
	let resp;
	try {
		resp = await sendRequest(socketPath, asSender ? "agent.resumeAsSender" : "agent.resume", params, { timeoutMs: await launchApprovalTimeoutMs(socketPath) });
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Socket timeout")) {
			return exitError("Timed out waiting for the resume", "The approval dialog may still be open and a later approval still resumes the task. Running the same command again waits on that same request.");
		}
		throw err;
	}
	if (!resp.ok) {
		exitOnSenderError(resp.error);
		return exitError(resp.error || "Failed to resume the task");
	}
	reportResumeOutcome(resp.data as CliResumeOutcome, json);
}

/** Shared with `dev3 task wake --resume`, which reports the same outcome with the same exit codes. */
export function reportResumeOutcome(result: CliResumeOutcome, json: boolean): void {
	if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	switch (result.outcome) {
		case "resumed": {
			const { resume } = result;
			if (!json) {
				const session = resume.tmux ? ` (tmux session ${resume.tmux.session})` : "";
				process.stdout.write(`Resumed task ${formatTaskRef(resume.seq)} on ${resume.backend}${session}${resume.woke ? ", woken from hibernation" : ""}:\n`);
				for (const pane of resume.panes) process.stdout.write(describePane(pane));
			}
			return;
		}
		case "already-running":
			return exitError(`Task ${formatTaskRef(result.seq)} already has a running terminal (${result.backend}) — nothing was resumed`, "Use dev3 peek to look at it, or dev3 agent spawn to add an agent.", CLI_EXIT_CODE_RESUME_ALREADY_RUNNING);
		case "unavailable": {
			const panes = (result.panes ?? []).map((pane) => describePane(pane).trim());
			const hint = result.reason === "session-id-unknown"
				? [...panes, "Pass --allow-agent-latest to resume each harness's own latest conversation anyway."].join("\n")
				: panes.length ? panes.join("\n") : undefined;
			return exitError(`Cannot resume task ${formatTaskRef(result.seq)}: ${result.message}`, hint, CLI_EXIT_CODE_RESUME_UNAVAILABLE);
		}
		case "declined":
			return exitError(result.stale ? "The target task's run ended before approval" : "User declined the resume request", "Nothing was resumed.", CLI_EXIT_CODE_LAUNCH_DECLINED);
	}
}

interface AwsProfilesView {
	agentId: string;
	name: string;
	profiles: Array<{ name: string; awsProfile: string; region?: string }>;
	defaultProfile: string | null;
}

/** `<name>=<AWS_PROFILE>[,<AWS_REGION>]` → one profile entry. */
export function parseAwsProfileSpec(spec: string): { name: string; awsProfile: string; region?: string } {
	const eq = spec.indexOf("=");
	if (eq <= 0) throw new Error(`--profile "${spec}" must look like <name>=<AWS_PROFILE>[,<AWS_REGION>].`);
	const name = spec.slice(0, eq).trim();
	const [awsProfile = "", region = "", ...extra] = spec.slice(eq + 1).split(",").map((part) => part.trim());
	if (!name || !awsProfile || extra.length) throw new Error(`--profile "${spec}" must look like <name>=<AWS_PROFILE>[,<AWS_REGION>].`);
	return { name, awsProfile, ...(region ? { region } : {}) };
}

function printAwsProfiles(view: AwsProfilesView): void {
	process.stdout.write(`${view.agentId}  ${view.name}\n`);
	if (view.profiles.length === 0) process.stdout.write("  (no profiles: the project env decides)\n");
	for (const p of view.profiles) {
		const mark = p.name === view.defaultProfile ? "*" : " ";
		process.stdout.write(`  ${mark} ${p.name}  AWS_PROFILE=${p.awsProfile}${p.region ? `  AWS_REGION=${p.region}` : ""}\n`);
	}
}

/** List or replace the AWS profiles a Bedrock agent offers in the launch dialog. */
async function handleAwsProfiles(args: ParsedArgs, socketPath: string): Promise<void> {
	const action = args.positional[0];
	const json = "json" in args.flags;
	if (action === "list") {
		rejectUnknownFlags(args, ["agent", "json"]);
		const resp = await sendRequest(socketPath, "agent.awsProfiles.list", args.flags.agent ? { agentId: args.flags.agent } : {});
		if (!resp.ok) return exitError(resp.error || "Failed to list AWS profiles");
		const views = resp.data as AwsProfilesView[];
		if (json) process.stdout.write(`${JSON.stringify(views, null, 2)}\n`);
		else if (views.length === 0) process.stdout.write("No agent is on an Amazon Bedrock backend.\n");
		else views.forEach(printAwsProfiles);
		return;
	}
	if (action !== "set") return exitUsage("Usage: dev3 agent aws-profiles list [--agent <id>] [--json] | dev3 agent aws-profiles set --agent <id> (--profile <name>=<AWS_PROFILE>[,<AWS_REGION>]... | --clear) [--default <name> | --no-default] [--json]");
	rejectUnknownFlags(args, ["agent", "profile", "default", "no-default", "clear", "json"]);
	if (!args.flags.agent) return exitUsage("--agent is required (see dev3 agent aws-profiles list).");
	const specs = args.repeated?.profile ?? (args.flags.profile ? [args.flags.profile] : []);
	const clear = "clear" in args.flags;
	if (clear === specs.length > 0) return exitUsage("Pass the full list as --profile flags, or --clear to remove every profile.");
	let profiles;
	try {
		profiles = specs.map(parseAwsProfileSpec);
	} catch (err) {
		return exitUsage(err instanceof Error ? err.message : String(err));
	}
	const resp = await sendRequest(socketPath, "agent.awsProfiles.set", {
		agentId: args.flags.agent,
		profiles,
		...(args.flags.default ? { defaultProfile: args.flags.default } : "no-default" in args.flags ? { defaultProfile: null } : {}),
	});
	if (!resp.ok) return exitError(resp.error || "Failed to set AWS profiles");
	const view = resp.data as AwsProfilesView;
	if (json) process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
	else printAwsProfiles(view);
}
