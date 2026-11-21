import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType, type RefObject } from "react";
import type { Context } from "cordis";
import { useT } from "../i18n";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { OverflowDotsIcon } from "../components/HeaderIcons";
import { CordisContext } from "./react";
import { SlotErrorBoundary } from "./SlotHost";
import type { SlotEntry, SlotItem, SlotRegistry } from "./slot-registry";

/** Where an item is drawn: in the bar itself, or as a row of the "More" menu. */
export type SlotItemPlacement = "inline" | "overflow";

export interface SlotItemProps {
	ctx: Context;
	placement: SlotItemPlacement;
}

/** One contribution. `when` hides it for the host's current scope (e.g. a task without a PR). */
export interface ContributionSlotItem<Scope = unknown> extends SlotItem {
	component: ComponentType<SlotItemProps>;
	when?: (scope: Scope) => boolean;
}

function isShown<Scope>(entry: SlotEntry<ContributionSlotItem<Scope>>, scope: Scope): boolean {
	if (!entry.def.when) return true;
	try {
		return entry.def.when(scope);
	} catch (err) {
		console.error(`[slots] when() of ${entry.def.id} threw; hiding it:`, err);
		return false;
	}
}

function Item<Scope>({ slot, entry, placement }: { slot: string; entry: SlotEntry<ContributionSlotItem<Scope>>; placement: SlotItemPlacement }) {
	const Component = entry.def.component;
	// A crashing contributor drops only its own item; the bar and its neighbours stay.
	return (
		<SlotErrorBoundary slot={slot} resetKey={entry.def.id} fallback={() => null}>
			<CordisContext.Provider value={entry.ctx}>
				<Component ctx={entry.ctx} placement={placement} />
			</CordisContext.Provider>
		</SlotErrorBoundary>
	);
}

export interface SlotItemsProps<Scope> {
	registry: SlotRegistry<ContributionSlotItem<Scope>>;
	/** Only this region's items; all of the slot's items when omitted. */
	region?: string;
	/** Passed to every item's `when`. */
	scope: Scope;
	/** How many items fit inline; the rest go under "More". No limit when omitted. */
	budget?: number;
	className?: string;
}

/**
 * A contribution slot: every registered item in order, each isolated in its own
 * error boundary. The host owns the bar, the order and the budget.
 */
export function SlotItems<Scope>({ registry, region, scope, budget, className }: SlotItemsProps<Scope>) {
	const getEntries = useCallback(
		() => (region === undefined ? registry.list() : registry.listRegion(region)),
		[registry, region],
	);
	const entries = useSyncExternalStore(registry.subscribe, getEntries);
	const shown = entries.filter((entry) => isShown(entry, scope));
	const limit = budget === undefined ? shown.length : Math.max(0, budget);
	const inline = shown.slice(0, limit);
	const overflow = shown.slice(limit);
	return (
		<div className={className ?? "flex items-center gap-1.5"} data-slot={registry.name} data-region={region}>
			{inline.map((entry) => <Item key={entry.def.id} slot={registry.name} entry={entry} placement="inline" />)}
			{overflow.length > 0 && <OverflowMenu slot={registry.name} entries={overflow} />}
		</div>
	);
}

function OverflowMenu<Scope>({ slot, entries }: { slot: string; entries: readonly SlotEntry<ContributionSlotItem<Scope>>[] }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => setOpen(false), []);
	return (
		<div className="relative">
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-label={t("slots.more")}
				title={t("slots.more")}
				aria-haspopup="menu"
				aria-expanded={open}
				className={`flex items-center px-1.5 py-1 rounded-lg border transition-[color,background-color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] ${
					open ? "text-fg bg-elevated border-edge-active" : "text-fg-2 border-edge bg-raised/60 hover:text-fg hover:bg-elevated hover:border-edge-active"
				}`}
			>
				<OverflowDotsIcon className="w-[1.125rem] h-[1.125rem]" />
			</button>
			{open && <OverflowPanel slot={slot} entries={entries} triggerRef={triggerRef} onDismiss={close} />}
		</div>
	);
}

function OverflowPanel<Scope>({ slot, entries, triggerRef, onDismiss }: {
	slot: string;
	entries: readonly SlotEntry<ContributionSlotItem<Scope>>[];
	triggerRef: RefObject<HTMLButtonElement | null>;
	onDismiss: () => void;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	useOverlayLayer(panelRef, { onDismiss, triggerRef, autoFocus: true });
	useEffect(() => {
		function onMouseDown(e: MouseEvent) {
			const target = e.target as Node;
			if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
			onDismiss();
		}
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [onDismiss, triggerRef]);
	return (
		<div
			ref={panelRef}
			role="menu"
			// A row that acts closes the menu; a stateful row (a toggle) can stop the click to stay open.
			onClick={(e) => {
				if ((e.target as Element).closest?.('[role="menuitem"]')) onDismiss();
			}}
			className="absolute right-0 top-full mt-1.5 min-w-52 bg-overlay border border-edge rounded-xl shadow-2xl z-50 py-1"
		>
			{entries.map((entry) => <Item key={entry.def.id} slot={slot} entry={entry} placement="overflow" />)}
		</div>
	);
}

export interface FoldOptions {
	/** The width one inline item takes, gap included. */
	itemWidth: number;
	/** Width kept free for everything else in the container, the "More" button included. */
	reserve?: number;
	/** Never more than this many, however wide the container. */
	max?: number;
}

/** Pure: how many items of `itemWidth` fit in `width`. */
export function foldBudget(width: number, { itemWidth, reserve = 0, max = Number.POSITIVE_INFINITY }: FoldOptions): number {
	if (itemWidth <= 0) return max;
	return Math.max(0, Math.min(max, Math.floor((width - reserve) / itemWidth)));
}

/**
 * A `budget` for `SlotItems` that follows the container's width, so items fold
 * into "More" as the window narrows. Until the first measurement, `max` (no fold).
 */
export function useFoldBudget(containerRef: RefObject<HTMLElement | null>, options: FoldOptions): number | undefined {
	const { itemWidth, reserve = 0, max } = options;
	const [width, setWidth] = useState<number | null>(null);
	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		setWidth(el.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setWidth(el.clientWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, [containerRef]);
	if (width === null || width === 0) return max;
	return foldBudget(width, { itemWidth, reserve, max });
}
