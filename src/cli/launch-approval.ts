import { sendRequest } from "./socket-client";
import { LAUNCH_PREPARATION_REPORT_BUDGET_MS } from "../shared/launch-preparation";

const BASE_TIMEOUT_MS = 10 * 60 * 1000;
const GRACE_MS = 2 * 60 * 1000;

export async function launchApprovalTimeoutMs(socketPath: string): Promise<number> {
	try {
		const resp = await sendRequest(socketPath, "approval.policy", {}, { timeoutMs: 5_000, connectAttempts: 1 });
		if (!resp.ok) return BASE_TIMEOUT_MS;
		const policy = resp.data as { autoApproveMs?: unknown };
		const deadline = typeof policy.autoApproveMs === "number" ? policy.autoApproveMs : 0;
		return Number.isFinite(deadline) && deadline > 0 ? Math.max(BASE_TIMEOUT_MS, deadline + GRACE_MS) : BASE_TIMEOUT_MS;
	} catch {
		return BASE_TIMEOUT_MS;
	}
}

/** A task launch also waits for the launched task's preparation to settle before the app answers. */
export async function launchAndPrepareTimeoutMs(socketPath: string): Promise<number> {
	return await launchApprovalTimeoutMs(socketPath) + LAUNCH_PREPARATION_REPORT_BUDGET_MS;
}

export const WAIT_HEARTBEAT_MS = 60_000;

/**
 * Prints a line every minute while an approval wait runs. Gemini CLI kills a shell
 * command after 300 s without output, which would drop a ten-minute wait mid-way.
 */
export async function withWaitHeartbeat<T>(wait: Promise<T>): Promise<T> {
	const started = Date.now();
	const timer = setInterval(() => {
		const minutes = Math.round((Date.now() - started) / 60_000);
		process.stderr.write(`Still waiting for the user's answer in the dev-3.0 app (${minutes} min)...\n`);
	}, WAIT_HEARTBEAT_MS);
	try {
		return await wait;
	} finally {
		clearInterval(timer);
	}
}
