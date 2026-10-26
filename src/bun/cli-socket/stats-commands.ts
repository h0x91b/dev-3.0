import { handlers as rpc } from "../rpc-handlers";
import { listPendingApprovalSummaries } from "../agent-requests";
import type { Handler } from "./shared";

/**
 * Read-only views of what the Stats page and the approval dialogs show. Each is
 * the renderer's own handler, unchanged; filtering by project or time happens in
 * the CLI so these stay plain pass-throughs.
 */
export const statsHandlers: Record<string, Handler> = {
	"stats.productivity": async () => rpc.getProductivityStats(),
	"stats.usage": async () => rpc.getAgentUsage(),
	"stats.limits": async () => rpc.getAgentRateLimits(),
	"stats.memory": async () => rpc.getSystemMemory(),
	"approvals.list": async () => ({ requests: listPendingApprovalSummaries() }),
};
