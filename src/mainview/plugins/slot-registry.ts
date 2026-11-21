import { Context, Service } from "cordis";

/**
 * What every slot item carries. `region` names a sub-area of a contribution slot;
 * `order` sorts within the slot (missing = 0), ties keep registration order.
 */
export interface SlotItem {
	id: string;
	region?: string;
	order?: number;
}

/** A replace slot shows one item at a time; a contribution slot shows many. */
export type SlotKind = "replace" | "contribute";

/** A registered item and the context of the plugin that registered it. */
export interface SlotEntry<Item extends SlotItem> {
	def: Item;
	ctx: Context;
}

export interface SlotOptions {
	kind: SlotKind;
	/** Lower-case singular for messages, e.g. "board view". */
	noun: string;
}

// `FiberState` is an ambient const enum (unreadable under isolatedModules): 0 PENDING, 1 LOADING, 2 ACTIVE.
function isLive(ctx: Context): boolean {
	const state = ctx.fiber?.state;
	return state === 0 || state === 1 || state === 2;
}

const NO_ENTRIES: readonly never[] = [];

/**
 * A named place plugins fill. `register` is a Cordis effect: the entry disappears
 * when the registering plugin is disposed, so a plugin never cleans up after itself.
 */
export class SlotRegistry<Item extends SlotItem> extends Service {
	readonly kind: SlotKind;
	readonly noun: string;
	private readonly entries = new Map<string, SlotEntry<Item>>();
	private readonly listeners = new Set<() => void>();
	private readonly refusalListeners = new Set<(id: string, ctx: Context) => void>();
	private snapshot: readonly SlotEntry<Item>[] = NO_ENTRIES;
	private regionSnapshots = new Map<string, readonly SlotEntry<Item>[]>();

	constructor(ctx: Context, name: string, options: SlotOptions) {
		super(ctx, name);
		this.kind = options.kind;
		this.noun = options.noun;
	}

	register(def: Item): () => void {
		// Reached through a plugin's context, `this.ctx` is that plugin's context
		// (Cordis tracks the caller), so the effect is owned by the registering plugin.
		const ctx = this.ctx;
		// First live registration wins: nobody replaces a built-in's (or another plugin's) id.
		// A restart of the owner, or an owner already on its way out, may replace.
		const existing = this.entries.get(def.id);
		if (existing && existing.ctx.fiber !== ctx.fiber && isLive(existing.ctx)) {
			for (const listener of this.refusalListeners) listener(def.id, ctx);
			throw new Error(`${capitalize(this.noun)} "${def.id}" is already registered`);
		}
		return ctx.effect(() => {
			const entry = { def, ctx };
			this.entries.set(def.id, entry);
			this.changed();
			return () => {
				if (this.entries.get(def.id) !== entry) return;
				this.entries.delete(def.id);
				this.changed();
			};
		}, `${this.name}:${def.id}`);
	}

	/** Told when `register` refuses an id that a live plugin already owns, with the refused caller's context. */
	readonly onRefused = (listener: (id: string, ctx: Context) => void): (() => void) => {
		this.refusalListeners.add(listener);
		return () => {
			this.refusalListeners.delete(listener);
		};
	};

	/** Every entry, by `order` then registration. The same array until something changes. */
	readonly list = (): readonly SlotEntry<Item>[] => this.snapshot;

	/** The entries of one region, in `list()` order; the same array until something changes. */
	readonly listRegion = (region: string): readonly SlotEntry<Item>[] => {
		let cached = this.regionSnapshots.get(region);
		if (!cached) {
			cached = this.snapshot.filter((entry) => entry.def.region === region);
			if (cached.length === 0) cached = NO_ENTRIES;
			this.regionSnapshots.set(region, cached);
		}
		return cached;
	};

	get(id: string): SlotEntry<Item> | undefined {
		return this.entries.get(id);
	}

	/** Arrow fields, so React's `useSyncExternalStore` gets stable identities. */
	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private changed(): void {
		// Array.prototype.sort is stable, so equal orders keep registration order.
		this.snapshot = [...this.entries.values()].sort((a, b) => (a.def.order ?? 0) - (b.def.order ?? 0));
		this.regionSnapshots = new Map();
		for (const listener of this.listeners) listener();
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
