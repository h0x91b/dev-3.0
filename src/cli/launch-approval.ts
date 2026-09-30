import { sendRequest } from "./socket-client";

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
