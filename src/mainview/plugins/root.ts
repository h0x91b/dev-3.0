import { Context } from "cordis";
import type { SlotItem, SlotRegistry } from "./slot-registry";

type AnySlot = SlotRegistry<SlotItem>;
type SlotFactory = (root: Context) => AnySlot;

let root: Context | null = null;
const slotFactories: SlotFactory[] = [];
const slots = new Map<SlotFactory, AnySlot>();
const slotObservers = new Set<(slot: AnySlot) => void>();

function createSlot(factory: SlotFactory, ctx: Context): AnySlot {
	const slot = factory(ctx);
	slots.set(factory, slot);
	for (const observer of slotObservers) observer(slot);
	return slot;
}

/**
 * The one renderer-wide Cordis root. Every defined slot is constructed with it:
 * a `Service` provides itself synchronously, so a surface can mount on the very
 * first frame without waiting for anything.
 */
export function getAppRoot(): Context {
	if (!root) {
		root = new Context();
		for (const factory of slotFactories) createSlot(factory, root);
	}
	return root;
}

/**
 * Declares a slot service on the app root, at module load of the surface that owns it.
 * Returns the getter for the live instance; a root reset (tests) builds a fresh one.
 */
export function defineAppSlot<S extends AnySlot>(create: (root: Context) => S): () => S {
	const factory: SlotFactory = create;
	slotFactories.push(factory);
	if (root) createSlot(factory, root);
	return () => {
		const ctx = getAppRoot();
		return (slots.get(factory) ?? createSlot(factory, ctx)) as S;
	};
}

/** Calls `observer` for every slot on the root, now and as later ones are created. */
export function observeAppSlots(observer: (slot: AnySlot) => void): () => void {
	slotObservers.add(observer);
	for (const slot of slots.values()) observer(slot);
	return () => {
		slotObservers.delete(observer);
	};
}

/** Load built-in plugins straight into the root. */
export function installIntoAppRoot(installs: ReadonlyArray<(ctx: Context) => unknown>): Context {
	const ctx = getAppRoot();
	for (const install of installs) install(ctx);
	return ctx;
}

export function resetAppRootForTests(): void {
	root = null;
	slots.clear();
	slotObservers.clear();
}
