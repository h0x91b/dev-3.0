import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	parseSocketMeta,
	parseTaskSocketOwner,
	socketMetaPathFor,
	taskSocketOwnerPath,
	type SocketMeta,
} from "../shared/socket-meta";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("socket-task-ownership");
const SOCKETS_DIR = `${DEV3_HOME}/sockets`;

function currentSocketPath(): string {
	return `${SOCKETS_DIR}/${process.pid}.sock`;
}

function readSocketMetaForPath(socketPath: string): SocketMeta | null {
	try {
		const meta = parseSocketMeta(readFileSync(socketMetaPathFor(socketPath), "utf-8"));
		const socketPid = Number(socketPath.match(/\/(\d+)\.sock$/)?.[1]);
		return meta && Number.isInteger(socketPid) && meta.pid === socketPid ? meta : null;
	} catch {
		return null;
	}
}

/**
 * Point one full task UUID at the logical owner of `socketPath`.
 *
 * Claims route by logical owner rather than PID; `claimantPid` only prevents an
 * old process from releasing a refreshed claim. An explicitly port-bound remote
 * publishes the same logical key after restart and immediately inherits its
 * background tasks. Random-port remotes are process-scoped because their
 * reconnectable endpoint changes. The shared-data invariant forbids renames
 * below ~/.dev3.0, so this is an in-place best-effort write and corrupt claims
 * safely degrade to normal socket discovery.
 */
export function claimSocketTaskOwnership(
	socketPath: string,
	taskId: string,
	claimedAt: number = Date.now(),
): boolean {
	const socketsDir = dirname(socketPath);
	const ownerPath = taskSocketOwnerPath(socketsDir, taskId);
	if (!ownerPath || !existsSync(socketMetaPathFor(socketPath))) return false;

	try {
		const meta = readSocketMetaForPath(socketPath);
		if (!meta) return false;
		mkdirSync(dirname(ownerPath), { recursive: true });
		writeFileSync(ownerPath, JSON.stringify({
			taskId,
			ownerKey: meta.ownerKey,
			claimedAt,
			claimantPid: meta.pid,
		}));
		return true;
	} catch (error) {
		log.warn("Failed to claim socket task ownership (non-fatal)", {
			taskId: taskId.slice(0, 8),
			error: String(error),
		});
		return false;
	}
}

/** Release only if this process still owns the task, protecting newer claims. */
export function releaseSocketTaskOwnership(socketPath: string, taskId: string): boolean {
	const ownerPath = taskSocketOwnerPath(dirname(socketPath), taskId);
	if (!ownerPath || !existsSync(ownerPath)) return false;

	try {
		const meta = readSocketMetaForPath(socketPath);
		const owner = parseTaskSocketOwner(readFileSync(ownerPath, "utf-8"));
		if (!meta || !owner || owner.ownerKey !== meta.ownerKey || owner.claimantPid !== meta.pid) return false;
		unlinkSync(ownerPath);
		return true;
	} catch (error) {
		log.warn("Failed to release socket task ownership (non-fatal)", {
			taskId: taskId.slice(0, 8),
			error: String(error),
		});
		return false;
	}
}

/** Terminal task cleanup removes any owner, regardless of which instance finishes it. */
export function clearTaskSocketOwnership(taskId: string): boolean {
	const ownerPath = taskSocketOwnerPath(SOCKETS_DIR, taskId);
	if (!ownerPath || !existsSync(ownerPath)) return false;
	try {
		unlinkSync(ownerPath);
		return true;
	} catch (error) {
		log.warn("Failed to clear socket task ownership (non-fatal)", {
			taskId: taskId.slice(0, 8),
			error: String(error),
		});
		return false;
	}
}

export function claimCurrentSocketTask(taskId: string): boolean {
	return claimSocketTaskOwnership(currentSocketPath(), taskId);
}

export function releaseCurrentSocketTask(taskId: string): boolean {
	return releaseSocketTaskOwnership(currentSocketPath(), taskId);
}
