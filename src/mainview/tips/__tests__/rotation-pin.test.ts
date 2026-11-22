import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectTip } from "../rotation";
import { getTipRegistry, tipStateKey, type Tip, type TipContext } from "../registry";
import { setAgentTrafficEnabledForTests } from "../../agent-traffic-flag";
import { resetPluginsForTests } from "../../plugins/runtime";
import { installTipBuiltins } from "./install-builtins";
import type { TipState } from "../../../shared/types";

const CONTEXTS: (TipContext | undefined)[] = [undefined, "board", "terminal", "diff", "settings", "preparing"];

/** Every tip one surface shows, in order, if the user presses Next until the pool runs dry. */
function drain(tips: readonly Tip[], context: TipContext | undefined): string[] {
	const state: TipState = { snoozedUntil: 0, seen: {}, rotationIndex: 0 };
	const shown: string[] = [];
	for (let tip = selectTip(tips, state, context); tip; tip = selectTip(tips, state, context)) {
		shown.push(tipStateKey(tip));
		state.seen[tipStateKey(tip)] = Date.now();
		state.rotationIndex++;
	}
	return shown;
}

// Pins the registry and its rotation byte for byte, so moving where the tips come from cannot
// reorder, drop or reword one. Regenerate the snapshot only when a tip change is the point.
describe("tip rotation pin", () => {
	beforeEach(async () => {
		resetPluginsForTests();
		await installTipBuiltins();
	});

	afterEach(() => setAgentTrafficEnabledForTests(true));

	it("keeps every tip and the order each surface shows them in", async () => {
		// What the app shows: the registered tips, in registration order, under the keys TipState stores.
		const tips = getTipRegistry().list().map((entry) => entry.def);
		setAgentTrafficEnabledForTests(true);
		const drains = Object.fromEntries(CONTEXTS.map((c) => [c ?? "(none)", drain(tips, c)]));
		setAgentTrafficEnabledForTests(false);
		const agentTrafficOff = drain(tips, undefined);
		const pinned = tips.map(({ when: _when, ...data }) => ({ ...data, id: tipStateKey(data) }));
		await expect(JSON.stringify({ tips: pinned, drains, agentTrafficOff }, null, 1))
			.toMatchFileSnapshot("./__snapshots__/tip-rotation.json");
	});
});
