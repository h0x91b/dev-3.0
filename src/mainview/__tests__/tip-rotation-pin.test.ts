import { afterEach, describe, expect, it } from "vitest";
import { ALL_TIPS, selectTip, type TipContext } from "../tips";
import { setAgentTrafficEnabledForTests } from "../agent-traffic-flag";
import type { TipState } from "../../shared/types";

const CONTEXTS: (TipContext | undefined)[] = [undefined, "board", "terminal", "diff", "settings", "preparing"];

/** Every tip one surface shows, in order, if the user presses Next until the pool runs dry. */
function drain(context: TipContext | undefined): string[] {
	const state: TipState = { snoozedUntil: 0, seen: {}, rotationIndex: 0 };
	const shown: string[] = [];
	for (let tip = selectTip(state, context); tip; tip = selectTip(state, context)) {
		shown.push(tip.id);
		state.seen[tip.id] = Date.now();
		state.rotationIndex++;
	}
	return shown;
}

// Pins the registry and its rotation byte for byte, so moving where the tips come from cannot
// reorder, drop or reword one. Regenerate the snapshot only when a tip change is the point.
describe("tip rotation pin", () => {
	afterEach(() => setAgentTrafficEnabledForTests(true));

	it("keeps every tip and the order each surface shows them in", async () => {
		setAgentTrafficEnabledForTests(true);
		const drains = Object.fromEntries(CONTEXTS.map((c) => [c ?? "(none)", drain(c)]));
		setAgentTrafficEnabledForTests(false);
		const agentTrafficOff = drain(undefined);
		await expect(JSON.stringify({ tips: ALL_TIPS, drains, agentTrafficOff }, null, 1))
			.toMatchFileSnapshot("./__snapshots__/tip-rotation.json");
	});
});
