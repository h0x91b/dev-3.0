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
	/**
	 * `"overflow"` is a row of a real `role="menu"`: render exactly one focusable element with
	 * `role="menuitem"` (or `menuitemcheckbox`/`menuitemradio`). Activating it closes the menu;
	 * a stateful row that must stay open stops the click's propagation.
	 */
	placement: SlotItemPlacement;
}

/** One contribution. `when` hides it for the host's current scope (e.g. a task without a PR). */
export interface ContributionSlotItem<Scope = unknown> extends SlotItem {
	component: ComponentType<SlotItemProps>;
	when?: (scope: Scope) => boolean;
}

/**
 * The user's arrangement of one slot (bible §5.10, §5.12). `order` wins over the default
 * order; `pinned` brings extension items into the bar; `overflow` sends any item to More.
 */
export interface SlotUserLayout {
	order?: readonly string[];
	pinned?: readonly string[];
	overflow?: readonly string[];
}

const MENU_ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/** Built-ins register `builtin:<id>`; everything else came from an extension. */
export function isBuiltinItem(id: string): boolean {
	return id.startsWith("builtin:");
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

type Entry<Scope> = SlotEntry<ContributionSlotItem<Scope>>;

/**
 * Who goes where, by origin (bible §5.1, §5.12). Order: user layout → built-ins →
 * extensions. Built-ins are never budgeted and never folded into More (a tight bar
 * folds their labels instead); only the user sends one there. Extension items start
 * in More until the user pins them, and pinned ones share whatever room the built-ins
 * leave under `budget`.
 */
export function placeSlotItems<T extends { def: { id: string } }>(
	entries: readonly T[],
	layout: SlotUserLayout = {},
	budget?: number,
): { inline: T[]; overflow: T[] } {
	const rank = new Map((layout.order ?? []).map((id, index) => [id, index]));
	const pinned = new Set(layout.pinned ?? []);
	const userOverflow = new Set(layout.overflow ?? []);
	const sorted = entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) =>
			(rank.get(a.entry.def.id) ?? Infinity) - (rank.get(b.entry.def.id) ?? Infinity)
			|| Number(!isBuiltinItem(a.entry.def.id)) - Number(!isBuiltinItem(b.entry.def.id))
			|| a.index - b.index)
		.map(({ entry }) => entry);
	const builtins = sorted.filter((entry) => isBuiltinItem(entry.def.id) && !userOverflow.has(entry.def.id));
	let room = budget === undefined ? Infinity : Math.max(0, budget - builtins.length);
	const inline: T[] = [];
	const overflow: T[] = [];
	for (const entry of sorted) {
		const id = entry.def.id;
		if (userOverflow.has(id)) overflow.push(entry);
		else if (isBuiltinItem(id)) inline.push(entry);
		else if (pinned.has(id) && room > 0) {
			inline.push(entry);
			room--;
		} else overflow.push(entry);
	}
	return { inline, overflow };
}

function Item<Scope>({ slot, entry, placement }: { slot: string; entry: Entry<Scope>; placement: SlotItemPlacement }) {
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
	/** The user's arrangement; without one, extension items wait in More. */
	layout?: SlotUserLayout;
	/** The bar's visible budget. Built-ins always show; pinned extension items fill what is left. */
	budget?: number;
	className?: string;
}

/**
 * A contribution slot: every registered item, placed by origin and user layout, each
 * isolated in its own error boundary. The host owns the bar, the order and the budget.
 * An item moving between the bar and More remounts, so it keeps no local state across.
 */
export function SlotItems<Scope>({ registry, region, scope, layout, budget, className }: SlotItemsProps<Scope>) {
	const getEntries = useCallback(
		() => (region === undefined ? registry.list() : registry.listRegion(region)),
		[registry, region],
	);
	const entries = useSyncExternalStore(registry.subscribe, getEntries);
	const { inline, overflow } = placeSlotItems(entries.filter((entry) => isShown(entry, scope)), layout, budget);
	return (
		<div className={className ?? "flex items-center gap-1.5"} data-slot={registry.name} data-region={region}>
			{inline.map((entry) => <Item key={entry.def.id} slot={registry.name} entry={entry} placement="inline" />)}
			{overflow.length > 0 && <OverflowMenu slot={registry.name} entries={overflow} />}
		</div>
	);
}

function OverflowMenu<Scope>({ slot, entries }: { slot: string; entries: readonly Entry<Scope>[] }) {
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
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" && !open) {
						e.preventDefault();
						setOpen(true);
					}
				}}
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

function menuItems(panel: HTMLElement | null): HTMLElement[] {
	if (!panel) return [];
	return Array.from(panel.querySelectorAll<HTMLElement>(MENU_ITEM)).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");
}

function OverflowPanel<Scope>({ slot, entries, triggerRef, onDismiss }: {
	slot: string;
	entries: readonly Entry<Scope>[];
	triggerRef: RefObject<HTMLButtonElement | null>;
	onDismiss: () => void;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	// Focus goes back to the trigger only when it was inside the menu (Escape, a row
	// activated); a dismissal caused by focus moving elsewhere leaves it there.
	const dismiss = useCallback(() => {
		const inside = !!panelRef.current?.contains(document.activeElement);
		onDismiss();
		if (inside) triggerRef.current?.focus();
	}, [onDismiss, triggerRef]);
	useOverlayLayer(panelRef, { onDismiss: dismiss, triggerRef });
	useEffect(() => {
		const panel = panelRef.current;
		menuItems(panel)[0]?.focus();
		for (const row of panel?.querySelectorAll<HTMLElement>("[data-slot-row]") ?? []) {
			if (row.childElementCount > 0 && !row.querySelector(MENU_ITEM)) {
				console.warn(`[slots] ${slot} item ${row.dataset.slotRow} renders no role="menuitem" in the More menu`);
			}
		}
	}, [slot]);
	useEffect(() => {
		function onMouseDown(e: MouseEvent) {
			const target = e.target as Node;
			if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
			onDismiss();
		}
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [onDismiss, triggerRef]);
	function onKeyDown(e: React.KeyboardEvent) {
		const items = menuItems(panelRef.current);
		if (items.length === 0) return;
		const current = items.indexOf(document.activeElement as HTMLElement);
		let next: number | null = null;
		if (e.key === "ArrowDown") next = (current + 1) % items.length;
		else if (e.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = items.length - 1;
		else if (e.key === "Tab") {
			onDismiss();
			return;
		}
		if (next === null) return;
		e.preventDefault();
		items[next].focus();
	}
	return (
		<div
			ref={panelRef}
			role="menu"
			onKeyDown={onKeyDown}
			onClick={(e) => {
				if ((e.target as Element).closest?.(MENU_ITEM)) dismiss();
			}}
			className="absolute right-0 top-full mt-1.5 min-w-52 bg-overlay border border-edge rounded-xl shadow-2xl z-50 py-1"
		>
			{entries.map((entry) => (
				<div key={entry.def.id} role="none" data-slot-row={entry.def.id}>
					<Item slot={slot} entry={entry} placement="overflow" />
				</div>
			))}
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
 * A `budget` for `SlotItems` that follows the container's width, so pinned extension
 * items fold into "More" as the window narrows (built-ins never do). Measure a parent
 * whose width does not depend on the items, or the budget can oscillate. The ref must
 * be attached on the first render. Until the first measurement, `max` (no fold).
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
