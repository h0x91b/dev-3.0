import type { Context, Fiber } from "cordis";
import type { ComponentType } from "react";
import Changelog from "../components/Changelog";
import ProductivityStatsView from "../components/ProductivityStatsView";
import SessionsScreen from "../components/SessionsScreen";
import type { BuiltinPlugin } from "../plugins/runtime";
import { useDestinationProps } from "./props";
// Defines the slot before the plugin injects it.
import "./registry";
import type { DestinationId } from "./registry";

function SessionsBody() {
	return <SessionsScreen {...useDestinationProps("sessions")} />;
}

function StatsBody() {
	return <ProductivityStatsView {...useDestinationProps("stats")} />;
}

function ChangelogBody() {
	return <Changelog {...useDestinationProps("changelog")} />;
}

/** Each destination's own body: registered as its slot item, and its undisableable fallback. */
export const BUILTIN_DESTINATION_BODIES: { readonly [D in DestinationId]: { id: string; component: ComponentType<{ ctx: Context }> } } = {
	sessions: { id: "builtin:sessions", component: SessionsBody },
	stats: { id: "builtin:stats", component: StatsBody },
	changelog: { id: "builtin:changelog", component: ChangelogBody },
};

const DESTINATION_BODIES_BUILTIN_ID = "builtin:destination-bodies";

/** Required: every destination falls back to its own body, so the user cannot switch these off. */
export const BUILTIN_DESTINATION_BODIES_PLUGIN: BuiltinPlugin = {
	id: DESTINATION_BODIES_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: DESTINATION_BODIES_BUILTIN_ID,
			inject: ["destinationBodies"],
			apply(pluginCtx: Context) {
				for (const [region, body] of Object.entries(BUILTIN_DESTINATION_BODIES)) {
					pluginCtx.destinationBodies.register({ ...body, region: region as DestinationId });
				}
			},
		});
	},
};
