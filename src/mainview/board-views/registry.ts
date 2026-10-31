import { Context, Service } from "cordis";
import type { ComponentType } from "react";

/** One way of showing a board. Built-ins and extensions register the same shape. */
export interface BoardViewDef {
	/** `builtin:<id>` for built-ins, `<extensionId>:<viewId>` for extensions. */
	id: string;
	/** An i18n key for built-ins, a plain string for extensions. */
	label: string;
	icon?: ComponentType | string;
	component: ComponentType<{ ctx: Context }>;
	supportsNarrow: boolean;
	defaultLayout?: unknown;
	/** Content of the host's "View options" popover; no icon is shown without it. */
	Options?: ComponentType<{ ctx: Context }>;
}

/** A registered view and the context of the plugin that registered it — the one its component receives. */
export interface RegisteredBoardView {
	def: BoardViewDef;
	ctx: Context;
}

/**
 * The board views currently registered. `register` is a Cordis effect: the
 * entry disappears when the registering plugin is disposed, so a plugin never
 * has to clean up after itself.
 */
export class BoardViewRegistry extends Service {
	private readonly entries = new Map<string, RegisteredBoardView>();
	private readonly listeners = new Set<() => void>();
	private snapshot: readonly RegisteredBoardView[] = [];

	constructor(ctx: Context) {
		super(ctx, "boardViews");
	}

	register(def: BoardViewDef): () => void {
		// Reached through a plugin's context, `this.ctx` is that plugin's context
		// (Cordis tracks the caller), so the effect is owned by the registering plugin.
		const ctx = this.ctx;
		return ctx.effect(() => {
			const entry = { def, ctx };
			this.entries.set(def.id, entry);
			this.changed();
			return () => {
				if (this.entries.get(def.id) !== entry) return;
				this.entries.delete(def.id);
				this.changed();
			};
		}, `boardView:${def.id}`);
	}

	/** Registration order is display order: built-ins first, extensions after. */
	readonly list = (): readonly RegisteredBoardView[] => this.snapshot;

	get(id: string): RegisteredBoardView | undefined {
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
		this.snapshot = [...this.entries.values()];
		for (const listener of this.listeners) listener();
	}
}
