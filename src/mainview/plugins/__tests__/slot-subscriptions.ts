import { observeAppSlots } from "../root";
import type { SlotItem, SlotRegistry } from "../slot-registry";

/** Counts each app slot's subscriptions from now on, by slot name: a perf budget's unit. */
export function countSlotSubscriptions(): Map<string, number> {
	const counts = new Map<string, number>();
	observeAppSlots((slot: SlotRegistry<SlotItem>) => {
		const subscribe = slot.subscribe;
		vi.spyOn(slot, "subscribe").mockImplementation((listener) => {
			counts.set(slot.name, (counts.get(slot.name) ?? 0) + 1);
			return subscribe(listener);
		});
	});
	return counts;
}
