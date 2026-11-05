import { readFile, writeFile } from "node:fs/promises";
import type { Task } from "../shared/types";
import type { NativeAgentAttribution, NativeTaskAgent } from "../shared/types/task-lifecycle";
import { createLogger } from "./logger";
import { nativeTaskPaneCommands } from "./native-task-panes";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { dev3TaskTempPath } from "./temp-paths";

const log = createLogger("native-agent-attribution");

/** The sidecar lives beside the launch script the pane's command points at. */
export function attributionPath(scriptPath: string): string {
	return `${scriptPath}.json`;
}

/** Best-effort: a native pane has no sessionState entry, so this is its only record. */
export async function writeNativeAgentAttribution(scriptPath: string, attribution: NativeAgentAttribution): Promise<void> {
	try {
		await writeFile(attributionPath(scriptPath), JSON.stringify(attribution));
	} catch (err) {
		log.warn("Could not write the native agent attribution sidecar", { scriptPath, error: String(err) });
	}
}

async function readAttribution(scriptPath: string): Promise<NativeAgentAttribution | null> {
	try {
		const parsed = JSON.parse(await readFile(attributionPath(scriptPath), "utf8"));
		return typeof parsed?.agentCmd === "string" ? (parsed as NativeAgentAttribution) : null;
	} catch {
		return null;
	}
}

/** A listed agent plus the shell pid of its pane. */
export type NativeTaskAgentPane = NativeTaskAgent & { shellPid: number };

/** Alive "+ Agent" and bug-hunter panes of a native task, matched by their launch script path. */
export async function listNativeTaskAgents(task: Task): Promise<NativeTaskAgentPane[]> {
	try {
		if (taskTerminalBackendIdentity(task) !== "native") return [];
		const prefixes = ["spawn-", "bughunt-"].map((kind) => dev3TaskTempPath(task.id, kind));
		const agents: NativeTaskAgentPane[] = [];
		for (const pane of await nativeTaskPaneCommands(task.id)) {
			const scriptPath = pane.alive ? pane.command.find((arg) => prefixes.some((prefix) => arg.startsWith(prefix))) : undefined;
			const attribution = scriptPath ? await readAttribution(scriptPath) : null;
			if (attribution) agents.push({ ...attribution, paneId: pane.paneId, shellPid: pane.shellPid });
		}
		return agents;
	} catch (err) {
		log.warn("Could not list native task agents", { taskId: task.id.slice(0, 8), error: String(err) });
		return [];
	}
}
