import type { CliResponse, DevServerStatus } from "../../shared/types";
import { isInstanceLossError, sendRequest } from "../socket-client";
import { printDetail, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { discoverSocketExcluding, expandShortId, resolveProjectId, type CliContext } from "../context";

const WAIT_POLL_MS = 500;
const WAIT_DEFAULT_TIMEOUT_S = 120;

/**
 * devServer.* transport with instance failover. The instance serving a
 * stop/restart can die mid-request when the target dev session hosts a dev3
 * app of its own (dev-3.0 dogfooding: `bun run dev` boots dev-3.0 inside
 * dev-3.0) — the teardown reaps the responder itself, so the reply never
 * arrives and every reconnect to the same socket is refused (#910/#920). All
 * devServer.* ops are idempotent, so on such an instance loss we re-discover
 * (excluding the dead socket) and replay once against a surviving instance —
 * typically the primary app, which also finishes any teardown the dying
 * instance left incomplete. `socketRef` is updated in place so follow-up
 * requests (e.g. --wait status polls) stick to the surviving instance.
 */
async function sendWithInstanceFailover(
	socketRef: { current: string },
	method: string,
	params: Record<string, unknown>,
): Promise<CliResponse> {
	try {
		return await sendRequest(socketRef.current, method, params, { retryEmptyResponse: true });
	} catch (err) {
		if (!isInstanceLossError(err)) throw err;
		const fallback = discoverSocketExcluding([socketRef.current]);
		if (!fallback || fallback === socketRef.current) throw err;
		process.stderr.write(
			`note: the app instance serving this command went away mid-request; retrying via ${fallback}\n`,
		);
		socketRef.current = fallback;
		return await sendRequest(fallback, method, params, { retryEmptyResponse: true });
	}
}

/**
 * Coerce a raw `devServer.*` RPC payload into a DevServerStatus with every
 * array field guaranteed present. Guards against version skew: the `dev3` CLI
 * and the running app are versioned independently, so a CLI newer than the app
 * receives a status missing fields the older backend never sent (e.g.
 * `devPorts`/`portConflicts`, added after v1.27.4). Without this, the rendering
 * helpers below dereference `undefined.length` and the whole command crashes
 * with "undefined is not an object (evaluating 'ports.length')" instead of
 * printing a clean status.
 */
function asStatus(data: unknown): DevServerStatus {
	const raw = (data ?? {}) as DevServerStatus;
	return {
		...raw,
		panePids: raw.panePids ?? [],
		assignedPorts: raw.assignedPorts ?? [],
		ports: raw.ports ?? [],
		devPorts: raw.devPorts ?? [],
		portConflicts: raw.portConflicts ?? [],
	};
}

function resolveTaskId(args: ParsedArgs, context: CliContext | null): string | undefined {
	const raw = args.positional[0] || args.flags.id || context?.taskId;
	if (!raw) return undefined;
	return expandShortId(raw, context);
}

function formatAssignedPorts(status: DevServerStatus): string {
	if (status.assignedPorts.length === 0) return "(none allocated)";
	return status.assignedPorts.map((port, index) => `DEV3_PORT${index}=${port}`).join(", ");
}

function formatPortInfos(ports: DevServerStatus["ports"]): string {
	if (ports.length === 0) return "(none detected)";
	return ports.map((port) => `${port.port} (${port.processName} pid ${port.pid})`).join(", ");
}

function formatPids(status: DevServerStatus): string {
	if (status.panePids.length === 0) return "(none)";
	return status.panePids.join(", ");
}

function printStatusLine(action: string, status: DevServerStatus): void {
	const shortTaskId = status.taskId.slice(0, 8);
	switch (action) {
		case "start":
			process.stdout.write(`Started dev server for task ${shortTaskId}\n`);
			return;
		case "restart":
			process.stdout.write(`Restarted dev server for task ${shortTaskId}\n`);
			return;
		case "stop":
			process.stdout.write(`Stopped dev server for task ${shortTaskId}\n`);
			return;
		default:
			if (status.tmuxError) {
				process.stdout.write(`Dev server status is unknown for task ${shortTaskId} (tmux could not be reached)\n`);
				return;
			}
			process.stdout.write(`Dev server is ${status.running ? "running" : "stopped"} for task ${shortTaskId}\n`);
	}
}

function printStatusDetails(status: DevServerStatus): void {
	const fields: Array<[string, string]> = [
		["State:", status.tmuxError ? "unknown (tmux unavailable)" : status.running ? "running" : "stopped"],
		["Task:", status.taskId.slice(0, 8)],
		["Session:", status.devSessionName],
		["Viewer Pane:", status.viewerPaneId ?? "(none)"],
		["Socket:", status.tmuxSocket],
		["Worktree:", status.worktreePath ?? "(none)"],
		["Pane PIDs:", formatPids(status)],
		["Assigned Ports:", formatAssignedPorts(status)],
		["Detected Ports:", formatPortInfos(status.ports)],
		["Dev Ports:", formatPortInfos(status.devPorts)],
	];

	if (status.resourceUsage) {
		fields.push(["CPU:", String(status.resourceUsage.cpu)]);
		fields.push(["Memory:", String(status.resourceUsage.rss)]);
	}

	printDetail(fields);
	printPortConflicts(status);
	if (status.tmuxError) {
		process.stdout.write(`WARNING: ${status.tmuxError}\n`);
	}
}

function printPortConflicts(status: DevServerStatus): void {
	for (const conflict of status.portConflicts) {
		process.stdout.write(
			`WARNING: port ${conflict.port} is already in use by ${conflict.processName} (pid ${conflict.pid}) — not owned by this dev server\n`,
		);
	}
}

/**
 * Poll `devServer.status` until the dev server's own process tree is
 * LISTENing on at least one port. With verified teardown on stop/restart the
 * old server is confirmed dead first, so a bound port here really is the NEW
 * server — not a stale process still serving the previous build.
 */
async function waitForDevServerReady(
	socketRef: { current: string },
	params: Record<string, unknown>,
	timeoutSec: number,
): Promise<void> {
	process.stdout.write(`Waiting for the dev server to open a port (timeout ${timeoutSec}s)...\n`);
	const timeoutMs = timeoutSec * 1000;
	for (let waited = 0; ; waited += WAIT_POLL_MS) {
		// A status read is idempotent, and the poll can straddle the tail of the
		// socket handoff — retry an empty response instead of aborting the wait.
		const resp = await sendWithInstanceFailover(socketRef, "devServer.status", params);
		if (!resp.ok) exitError(resp.error || "Failed to poll dev server status");
		const status = asStatus(resp.data);
		if (status.tmuxError) {
			exitError(status.tmuxError);
		}
		if (!status.running) {
			exitError("Dev server exited before opening a port — check the dev server pane for errors");
		}
		if (status.devPorts.length > 0) {
			process.stdout.write(`Ready: listening on ${status.devPorts.map((p) => p.port).join(", ")}\n`);
			return;
		}
		if (waited >= timeoutMs) {
			exitError(`Dev server did not open a port within ${timeoutSec}s (build still in progress?)`);
		}
		await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
	}
}

function parseWaitTimeout(args: ParsedArgs): number {
	const raw = args.flags.timeout;
	if (raw === undefined) return WAIT_DEFAULT_TIMEOUT_S;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed) || parsed <= 0) {
		exitUsage(`Invalid --timeout value: ${raw} (expected a positive number of seconds)`);
	}
	return parsed;
}

async function runAction(
	action: "start" | "stop" | "restart" | "status",
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const taskId = resolveTaskId(args, context);
	if (!taskId) {
		exitUsage(`Usage: dev3 dev-server ${action} <task-id>`);
	}

	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	// stop/restart tear the dev tmux session down; the app can drop this in-flight
	// connection mid-handoff and close it with no reply ("Empty response"). Every
	// devServer.* op is idempotent (start/restart re-kill any live session first;
	// stop/status are no-ops when already gone), so a short replay window turns a
	// false failure into the real status instead of a stopped-but-not-restarted
	// server the caller must recover by hand. When the serving instance itself
	// dies, sendWithInstanceFailover replays through a surviving instance.
	const socketRef = { current: socketPath };
	const resp = await sendWithInstanceFailover(socketRef, `devServer.${action}`, params);
	if (!resp.ok) exitError(resp.error || `Failed to ${action} dev server`);

	const status = asStatus(resp.data);
	printStatusLine(action, status);
	printStatusDetails(status);

	if ((action === "start" || action === "restart") && args.flags.wait !== undefined) {
		await waitForDevServerReady(socketRef, params, parseWaitTimeout(args));
	}
}

export async function handleDevServer(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case undefined:
		case "status":
			return runAction("status", args, socketPath, context);
		case "start":
			return runAction("start", args, socketPath, context);
		case "stop":
			return runAction("stop", args, socketPath, context);
		case "restart":
			return runAction("restart", args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: dev-server ${subcommand}` +
				"\nAvailable: dev-server start, dev-server stop, dev-server restart, dev-server status",
			);
	}
}
