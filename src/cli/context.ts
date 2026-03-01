import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Dev3Marker } from "../shared/types";

const HOME = process.env.HOME || "/tmp";
const DEV3_HOME = `${HOME}/.dev3.0`;
const SOCKETS_DIR = `${DEV3_HOME}/sockets`;

export interface CliContext {
	projectId: string;
	taskId: string;
	socketPath: string;
}

/**
 * Walk up from cwd to find .dev3-marker and resolve project/task context.
 */
export function detectContext(cwd: string = process.cwd()): CliContext | null {
	let dir = cwd;
	for (let i = 0; i < 30; i++) {
		const markerPath = `${dir}/.dev3-marker`;
		if (existsSync(markerPath)) {
			try {
				const marker: Dev3Marker = JSON.parse(readFileSync(markerPath, "utf-8"));
				return {
					projectId: marker.projectId,
					taskId: marker.taskId,
					socketPath: marker.socketPath,
				};
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Find any live socket in ~/.dev3.0/sockets/ (for commands without worktree context).
 */
export function discoverSocket(): string | null {
	if (!existsSync(SOCKETS_DIR)) return null;

	for (const file of readdirSync(SOCKETS_DIR)) {
		if (!file.endsWith(".sock")) continue;
		const pid = parseInt(file.replace(".sock", ""), 10);
		if (isNaN(pid)) continue;

		try {
			process.kill(pid, 0); // Check if alive
			return `${SOCKETS_DIR}/${file}`;
		} catch {
			// Dead process, skip
		}
	}
	return null;
}

/**
 * Get socket path: from marker (preferred) or by discovery.
 */
export function resolveSocketPath(cwd?: string): string | null {
	const ctx = detectContext(cwd);
	if (ctx?.socketPath && existsSync(ctx.socketPath)) {
		return ctx.socketPath;
	}
	return discoverSocket();
}
