/** OpenCode adapter. */
import { GENERIC_SKILL_BODY } from "../agent-skill-content";
import { agentCommandExecutable } from "../agent-command-executable";
import type { AgentConfiguration } from "../types";
import { modelArgs, providerArgs, slashExitProgram } from "./common";
import { commandToken, shellEscape } from "./shell";
import { buildTaskPrompt, type TemplateContext } from "./template";
import type { AdapterLaunchOptions, AgentAdapter } from "./types";

/** What dev3 sends to the V2 session API instead of root-TUI flags, which V2 refuses. */
export interface OpenCodeLaunchSpec {
	agent?: string;
	model?: { providerID: string; id: string; variant?: string };
	prompt?: string;
	sessionId?: string;
	additionalArgs: string[];
}

const RESERVED_TUI_ARGS = new Set(["--server", "--session", "-s", "--continue", "-c", "--prompt", "--dir", "--directory", "--standalone", "--agent"]);

/** The opencode executable of a V2 agent: bare or `env`-prefixed, with no arguments (dev3 manages them). */
export function openCodeBinary(baseCmd: string): string {
	const executable = agentCommandExecutable(baseCmd);
	if (executable.kind === "unknown") throw new Error("OpenCode V2 needs a direct opencode executable; shell expressions are not supported.");
	if (executable.kind === "name" && executable.name !== "opencode") {
		throw new Error(`OpenCode V2 server expected the opencode executable, found ${executable.name}.`);
	}
	const binary = executable.kind === "path" ? executable.path : executable.name;
	const normalized = baseCmd.trim();
	const token = commandToken(binary);
	if (normalized === `${token} mini` || normalized === `env ${token} mini`) {
		throw new Error("OpenCode V2 launches the full TUI; remove the `mini` subcommand from the base command override.");
	}
	if (normalized !== token && normalized !== `env ${token}`) {
		throw new Error("OpenCode V2 needs an opencode executable, optionally prefixed by `env`, without command-line arguments.");
	}
	return binary;
}

export function validateOpenCodeTuiArgs(additionalArgs: readonly string[]): void {
	if (additionalArgs.some((arg) => RESERVED_TUI_ARGS.has(arg.split("=", 1)[0]!))) {
		throw new Error("OpenCode additional arguments cannot override the managed server, session, workspace, agent, or initial prompt.");
	}
}

/** A preset's `--agent` becomes the session's agent; every other argument stays on the TUI. */
function splitAgentArgs(args: readonly string[]): { agent?: string; additionalArgs: string[] } {
	let agent: string | undefined;
	const additionalArgs: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg !== "--agent" && !arg.startsWith("--agent=")) {
			additionalArgs.push(arg);
			continue;
		}
		const value = arg === "--agent" ? args[++index] : arg.slice("--agent=".length);
		if (!value || value.startsWith("--")) throw new Error("OpenCode --agent needs an agent ID.");
		if (agent) throw new Error("OpenCode presets can select only one agent.");
		agent = value;
	}
	return { agent, additionalArgs };
}

export function buildOpenCodeLaunchSpec(config: AgentConfiguration | undefined, ctx: TemplateContext, options: AdapterLaunchOptions = {}): OpenCodeLaunchSpec {
	const { agent, additionalArgs } = splitAgentArgs(config?.additionalArgs ?? []);
	if (options.resume) {
		if (!options.sessionId) throw new Error("OpenCode cannot resume exactly because this pane has no saved session ID; start a fresh session instead.");
		return { additionalArgs, sessionId: options.sessionId };
	}
	const spec: OpenCodeLaunchSpec = { additionalArgs, ...(agent ? { agent } : {}) };
	if (config?.model && !options.skipModelForProvider) {
		const [qualifiedModel = "", variant, ...extra] = config.model.split("#");
		const separator = qualifiedModel.indexOf("/");
		if (extra.length > 0 || separator < 1 || separator === qualifiedModel.length - 1) {
			throw new Error(`OpenCode model must use provider/model format: ${config.model}`);
		}
		spec.model = { providerID: qualifiedModel.slice(0, separator), id: qualifiedModel.slice(separator + 1), ...(variant ? { variant } : {}) };
	}
	let prompt = buildTaskPrompt(config?.appendPrompt, ctx);
	if (prompt && !options.skipSystemPrompt) prompt = `${prompt}\n\n${options.protocolBody ?? GENERIC_SKILL_BODY}`;
	if (prompt) spec.prompt = prompt;
	return spec;
}

export function buildOpenCodeTuiCommand(binary: string, additionalArgs: readonly string[], serverUrl: string, sessionId: string): string {
	return [commandToken(binary), "--server", shellEscape(serverUrl), "--session", shellEscape(sessionId), ...additionalArgs.map(shellEscape)].join(" ");
}

export const opencodeAdapter: AgentAdapter = {
	command: "opencode",
	supportsResume: true,
	// Resume-only --session; no launch-time pre-assignment.
	supportsPreAssignedSessionId: false,
	skillBody: GENERIC_SKILL_BODY,
	skillFamily: "generic",
	trustKinds: ["claude"],

	launchArgs(baseCmd, config, ctx, options) {
		// V2 refuses these root flags: the Bun side attaches the TUI to a managed session (opencode-server.ts).
		if (options?.opencodeProtocol === "v2") return [baseCmd];

		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (resume) {
			if (options?.sessionId) args.push("--session", options.sessionId);
			else args.push("--continue");
		}

		args.push(...modelArgs(config, options));
		args.push(...providerArgs(options));
		// OpenCode ignores dev3's --permission-mode / --effort / --max-budget-usd.

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			let prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			if (prompt) prompt = `${prompt}\n\n${options?.protocolBody ?? GENERIC_SKILL_BODY}`;
			// OpenCode takes the prompt via --prompt (value form is unambiguous, so
			// no `--` separator is needed).
			if (prompt) args.push("--prompt", shellEscape(prompt));
		}

		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --session ${sessionId}` : `${baseCmd} --continue`;
	},

	hooksReportPermissionWaits: false,

	hooksSpec() {
		return null;
	},

	exitProgram() {
		return slashExitProgram("/exit");
	},
};
