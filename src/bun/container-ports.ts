import { realpathSync } from "node:fs";
import { runProbeText } from "./probe-spawn";

const DOCKER_PS_TIMEOUT_MS = 5_000;
const COMPOSE_WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

/**
 * Host ports published by running compose containers whose project lives in the
 * worktree. A runtime daemon holds them all under one PID, so only the compose
 * label tells this task's container from another project's.
 */
export async function findWorktreeContainerPorts(worktreePath: string): Promise<Set<number>> {
	const output = await runProbeText(
		["docker", "ps", "--format", `{{.Label "${COMPOSE_WORKING_DIR_LABEL}"}}\t{{.Ports}}`],
		DOCKER_PS_TIMEOUT_MS,
	);
	let resolved = worktreePath;
	try {
		resolved = realpathSync(worktreePath);
	} catch {
		// Worktree already removed — the raw path is all there is.
	}
	return parseWorktreeContainerPorts(output, [worktreePath, resolved]);
}

/** Parse `docker ps` lines of `<working dir>\t<ports>`, e.g. `/wt\t0.0.0.0:17501->8000/tcp, [::]:17501->8000/tcp`. */
export function parseWorktreeContainerPorts(output: string, worktreePaths: string[]): Set<number> {
	const roots = worktreePaths.map((path) => path.replace(/\/+$/, ""));
	const ports = new Set<number>();
	for (const line of output.split("\n")) {
		const [workingDir, published = ""] = line.split("\t");
		if (!workingDir || !roots.some((root) => workingDir === root || workingDir.startsWith(`${root}/`))) continue;
		for (const match of published.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
			const first = Number(match[1]);
			const last = match[2] ? Number(match[2]) : first;
			for (let port = first; port <= last; port++) ports.add(port);
		}
	}
	return ports;
}
