import { existsSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import type { CliRequest, CliResponse } from "../shared/types";
import { socketMetaPathFor } from "../shared/socket-meta";
import { isCliEndpointHandle } from "../shared/cli-endpoint";
import { DEV3_HOME } from "./paths";
import { cliTransportFor, startCliListener } from "./cli-listener";
import { agentHandlers } from "./cli-socket/agent-commands";
import { automationHandlers } from "./cli-socket/automation-commands";
import { boardMetadataHandlers } from "./cli-socket/board-metadata-commands";
import { externalSenderHandlers } from "./cli-socket/external-sender-commands";
import { liveHandlers } from "./cli-socket/live-commands";
import { messageHandlers } from "./cli-socket/message-commands";
import { paneHandlers } from "./cli-socket/pane-commands";
import { prWatchHandlers } from "./cli-socket/pr-watch-commands";
import { log, type Handler } from "./cli-socket/shared";
import { statsHandlers } from "./cli-socket/stats-commands";
import { systemHandlers } from "./cli-socket/system-commands";
import { taskHandlers } from "./cli-socket/task-commands";
import { uiHandlers } from "./cli-socket/ui-commands";

const SOCKETS_DIR = `${DEV3_HOME}/sockets`;

let socketPath = "";

export function getSocketPath(): string {
	return socketPath;
}

function cleanupStaleSockets(): void {
	if (!existsSync(SOCKETS_DIR)) return;

	for (const file of readdirSync(SOCKETS_DIR)) {
		// Socket, meta sidecar, and loopback endpoint record (`<pid>.sock` /
		// `<pid>.meta.json` / `<pid>.endpoint.json`) are all keyed by pid; a
		// SIGKILLed instance leaves them behind.
		if (!file.endsWith(".sock") && !file.endsWith(".meta.json") && !isCliEndpointHandle(file)) continue;
		const pid = parseInt(file.split(".")[0], 10);
		if (isNaN(pid)) continue;

		try {
			// Check if process is alive (signal 0 = no signal, just check)
			process.kill(pid, 0);
		} catch {
			// Process is dead — remove stale socket
			const stalePath = `${SOCKETS_DIR}/${file}`;
			log.info("Removing stale socket", { path: stalePath, pid });
			try {
				unlinkSync(stalePath);
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

const handlers: Record<string, Handler> = {
	...agentHandlers,
	...paneHandlers,
	...boardMetadataHandlers,
	...automationHandlers,
	...uiHandlers,
	...messageHandlers,
	...externalSenderHandlers,
	...prWatchHandlers,
	...statsHandlers,
	...systemHandlers,
	...taskHandlers,
	...liveHandlers,
};

export async function handleRequest(req: CliRequest, signal?: AbortSignal): Promise<CliResponse> {
	const handler = handlers[req.method];
	if (!handler) {
		return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
	}

	try {
		const result = await handler(req.params, { signal });
		return { id: req.id, ok: true, data: result };
	} catch (err) {
		return { id: req.id, ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}

/**
 * Start the CLI transport and return its endpoint handle: a `<pid>.sock` path on
 * POSIX, a `<pid>.endpoint.json` loopback record on Windows.
 */
export function startSocketServer(): string {
	mkdirSync(SOCKETS_DIR, { recursive: true });
	cleanupStaleSockets();

	const listener = startCliListener({
		socketsDir: SOCKETS_DIR,
		pid: process.pid,
		hostTaskId: process.env.DEV3_TASK_ID || null,
		transport: cliTransportFor(process.platform),
		handle: handleRequest,
	});
	socketPath = listener.endpoint;

	log.info("CLI socket server started", {
		path: socketPath,
		transport: listener.transport,
		port: listener.port ?? null,
		guestOfTask: process.env.DEV3_TASK_ID ?? null,
	});
	return socketPath;
}

export function stopSocketServer(): void {
	if (socketPath && existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
			log.info("CLI socket removed", { path: socketPath });
		} catch {
			// Ignore cleanup errors
		}
	}
	// The loopback endpoint record carries its own guest info, so only a `.sock`
	// handle has a separate sidecar to remove.
	const metaPath = socketPath && !isCliEndpointHandle(socketPath) ? socketMetaPathFor(socketPath) : "";
	if (metaPath && existsSync(metaPath)) {
		try {
			unlinkSync(metaPath);
		} catch {
			// Ignore cleanup errors
		}
	}
}
