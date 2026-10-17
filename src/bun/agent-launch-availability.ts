/**
 * Launch-boundary check: is the harness binary a launch would exec present on
 * THIS machine — the one running the bun process, which is the execution host
 * in desktop and remote/browser mode alike.
 *
 * The picker's "Not installed" pill is advisory and can be stale; every path that
 * starts an agent (modal, CLI, scheduled fire, extra pane) asks here before any
 * task is moved or worktree created, so a missing binary refuses the launch
 * instead of starting a dead pane under "Agent is Working".
 */
import type { CodingAgent, GlobalSettings } from "../shared/types";
import { agentAlternativeInstallCommand, agentInstallCommand, agentNotInstalledMessage } from "../shared/agent-install";
import { findConfig, getAllAgents } from "./agents";
import { agentBinaryPathOverride, isExecutableFile } from "./executable";
import { createLogger } from "./logger";
import { resolveBinaryPath } from "./rpc-handlers/shared-pure";
import { loadSettings } from "./settings";

const log = createLogger("agent-launch-availability");

export interface MissingAgentBinary {
	agentId: string;
	agentName: string;
	binaryName: string;
	installCommand?: string;
	alternativeInstallCommand?: string;
}

export class AgentNotInstalledError extends Error {
	constructor(readonly missing: MissingAgentBinary) {
		super(agentNotInstalledMessage(missing));
		this.name = "AgentNotInstalledError";
	}
}

/** Same resolution `launchTaskPty` uses to decide a binary is missing, keyed by
 *  the agent actually launched (its custom path is stored under its own id). */
export function resolveAgentLaunchBinary(
	agentId: string,
	baseCmd: string,
	settings: Pick<GlobalSettings, "agentBinaryPaths" | "agentCustomBinaryPaths">,
): { binaryName: string; resolvedPath?: string } {
	const binaryName = baseCmd.split("/").pop() ?? baseCmd;
	const overridePath = agentBinaryPathOverride(agentId, binaryName, settings.agentBinaryPaths, settings.agentCustomBinaryPaths);
	// A command given as a path is exec'd as that path: a same-named binary
	// elsewhere on PATH does not make it launchable.
	if (baseCmd.includes("/")) {
		const resolvedPath = [overridePath, baseCmd].find((p): p is string => !!p && isExecutableFile(p));
		return { binaryName, resolvedPath };
	}
	return { binaryName, resolvedPath: resolveBinaryPath(binaryName, overridePath).resolvedPath };
}

function launchedAgent(
	allAgents: CodingAgent[],
	settings: GlobalSettings,
	agentId: string | null | undefined,
	configId: string | null | undefined,
): { agent: CodingAgent; baseCmd: string } | null {
	// A null agent means the default, exactly as resolveCommandForProject picks it.
	const agent = allAgents.find((a) => a.id === (agentId ?? settings.defaultAgentId));
	if (!agent) return null;
	const config = findConfig(agent, configId ?? (agentId ? null : settings.defaultConfigId));
	return { agent, baseCmd: config?.baseCommandOverride || agent.baseCommand };
}

/**
 * The first launch whose binary is known missing, or null. Null also covers
 * "could not tell": a probe that fails is not proof of absence, so it never
 * blocks — the launch path keeps its own handling for that case.
 */
export async function findMissingLaunchAgent(
	launches: ReadonlyArray<{ agentId?: string | null; configId?: string | null }>,
): Promise<MissingAgentBinary | null> {
	let allAgents: CodingAgent[];
	let settings: GlobalSettings;
	try {
		// Both started inside promise chains: a synchronous throw from one must not
		// leave the other's rejection unhandled.
		[allAgents, settings] = await Promise.all([
			Promise.resolve().then(() => getAllAgents()),
			Promise.resolve().then(() => loadSettings()),
		]);
	} catch (err) {
		log.warn("Agent availability unknown — launch not blocked", { error: String(err) });
		return null;
	}
	for (const launch of launches) {
		const target = launchedAgent(allAgents, settings, launch.agentId, launch.configId);
		if (!target || !target.baseCmd || target.baseCmd === "bash") continue;
		let probe: ReturnType<typeof resolveAgentLaunchBinary>;
		try {
			probe = resolveAgentLaunchBinary(target.agent.id, target.baseCmd, settings);
		} catch (err) {
			log.warn("Agent binary probe failed — launch not blocked", { agentId: target.agent.id, error: String(err) });
			continue;
		}
		const { binaryName, resolvedPath } = probe;
		if (resolvedPath) continue;
		log.warn("Launch refused: agent binary missing", { agentId: target.agent.id, binaryName });
		return {
			agentId: target.agent.id,
			agentName: target.agent.name,
			binaryName,
			installCommand: agentInstallCommand(target.agent, process.platform),
			alternativeInstallCommand: agentAlternativeInstallCommand(target.agent, process.platform),
		};
	}
	return null;
}

export async function assertLaunchAgentsInstalled(
	launches: ReadonlyArray<{ agentId?: string | null; configId?: string | null }>,
): Promise<void> {
	const missing = await findMissingLaunchAgent(launches);
	if (missing) throw new AgentNotInstalledError(missing);
}
