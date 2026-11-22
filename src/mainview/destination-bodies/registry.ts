import type { Context } from "cordis";
import type { AgentTrafficScreenProps } from "../components/agent-traffic/AgentTrafficScreen";
import type { ChangelogProps } from "../components/Changelog";
import type { DashboardProps } from "../components/Dashboard";
import type { ProductivityStatsViewProps } from "../components/ProductivityStatsView";
import type { SessionsScreenProps } from "../components/SessionsScreen";
import { defineAppSlot } from "../plugins/root";
import type { ReplaceSlotItem } from "../plugins/SlotHost";
import { SlotRegistry } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `destinationBodies`, so the extension
// guard unloads any extension that registers here (decisions/2026/11/21/destination-body-slots.md).
declare module "cordis" {
	interface Context {
		destinationBodies: DestinationBodyRegistry;
	}
}

/**
 * What the host hands each destination's body; the route and header stay the host's.
 * The built-in screens' own props, so the contract cannot drift from them.
 */
export interface DestinationBodyProps {
	sessions: SessionsScreenProps;
	stats: ProductivityStatsViewProps;
	changelog: ChangelogProps;
	"agent-traffic": AgentTrafficScreenProps;
	/** Home: the project list. */
	dashboard: DashboardProps;
}

export type DestinationId = keyof DestinationBodyProps;

/** One way of drawing a destination's body. `region` names the destination it fills. */
export interface DestinationBodyItem extends ReplaceSlotItem {
	region: DestinationId;
}

export class DestinationBodyRegistry extends SlotRegistry<DestinationBodyItem> {
	constructor(ctx: Context) {
		super(ctx, "destinationBodies", { kind: "replace", noun: "screen body" });
	}
}

export const getDestinationBodyRegistry = defineAppSlot((root) => new DestinationBodyRegistry(root));
