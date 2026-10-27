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
	// Loaded on demand: pricing pulls the telemetry opt-out and the model catalog store.
	"stats.prices": async (params) => {
		const { describePricing } = await import("../agent-pricing-refresh");
		const { loadModelCatalog } = await import("../model-catalog-store");
		const { nativeModelIdForWireName } = await import("../../shared/model-catalog");
		const asked = Array.isArray(params.models) ? params.models.filter((m): m is string => typeof m === "string") : null;
		const models = asked ?? (await rpc.getAgentUsage()).models;
		const { fetchedAt, resolve } = await describePricing();
		const catalog = loadModelCatalog();
		// Priced exactly as the usage report prices a record: a catalog wire name as its native model.
		return {
			fetchedAt,
			models: models.map((model) => ({ model, rate: resolve(nativeModelIdForWireName(catalog, model) ?? model) })),
		};
	},
	"approvals.list": async () => ({ requests: listPendingApprovalSummaries() }),
};
