import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type RefObject } from "react";
import type { Context } from "cordis";
import { useT } from "../i18n";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { OverflowDotsIcon } from "../components/HeaderIcons";
import { contextMenuPosition } from "../hooks/useHideContextMenu";
import { useViewportClamp } from "../hooks/useViewportClamp";
import { createPortal } from "react-dom";
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
 * order; `pinned` brings extension items into the bar; `overflow` sends any item to More;
 * `hidden` drops an item from the slot altogether.
 */
export interface SlotUserLayout {
	order?: readonly string[];
	pinned?: readonly string[];
	overflow?: readonly string[];
	hidden?: readonly string[];
}

/** What the host's per-item menu needs to know about the region as it is drawn right now. */
export interface SlotItemMenuRequest {
	id: string;
	placement: SlotItemPlacement;
	/** Viewport position to open at. */
	at: { top: number; left: number };
	/** Gets focus back when the menu closes. */
	returnFocus: HTMLElement | null;
	/** Every registered item of the region, hidden ones included, in the order the user sees. */
	order: readonly string[];
	/** The inline items that actually render, left to right. */
	drawn: readonly string[];
	/** The items in the region's More menu. */
	overflow: readonly string[];
	/** How many more extension items fit in the bar before the budget is spent. */
	room: number;
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

/** The order the user sees: their own order first, then built-ins, then extensions, then registration. */
export function sortSlotEntries<T extends { def: { id: string } }>(entries: readonly T[], order: readonly string[] = []): T[] {
	const rank = new Map(order.map((id, index) => [id, index]));
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) =>
			(rank.get(a.entry.def.id) ?? Infinity) - (rank.get(b.entry.def.id) ?? Infinity)
			|| Number(!isBuiltinItem(a.entry.def.id)) - Number(!isBuiltinItem(b.entry.def.id))
			|| a.index - b.index)
		.map(({ entry }) => entry);
}

/**
 * Who goes where, by origin (bible §5.1, §5.12). Order: user layout → built-ins →
 * extensions. Built-ins are never budgeted and never folded into More (a tight bar
 * folds their labels instead); only the user sends one there. Extension items start
 * in More until the user pins them, and pinned ones share whatever room the built-ins
 * leave under `budget`. A built-in in `budgetExempt` takes none of that room, and
 * neither does one that draws nothing: with `rendered` known, only those in it count.
 */
export function placeSlotItems<T extends { def: { id: string } }>(
	entries: readonly T[],
	layout: SlotUserLayout = {},
	budget?: number,
	budgetExempt: ReadonlySet<string> = new Set(),
	rendered?: ReadonlySet<string>,
): { inline: T[]; overflow: T[]; room: number } {
	const pinned = new Set(layout.pinned ?? []);
	const userOverflow = new Set(layout.overflow ?? []);
	const hidden = new Set(layout.hidden ?? []);
	const sorted = sortSlotEntries(entries, layout.order).filter((entry) => !hidden.has(entry.def.id));
	const builtins = sorted.filter((entry) => {
		const id = entry.def.id;
		return isBuiltinItem(id) && !userOverflow.has(id) && !budgetExempt.has(id) && (!rendered || rendered.has(id));
	});
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
	return { inline, overflow, room };
}

/** The placement of the item being drawn, for hooks deep inside it that cannot take the prop. */
export const SlotItemPlacementContext = createContext<SlotItemPlacement>("inline");

function Item<Scope>({ slot, entry, placement }: { slot: string; entry: Entry<Scope>; placement: SlotItemPlacement }) {
	const Component = entry.def.component;
	// A crashing contributor drops only its own item; the bar and its neighbours stay.
	return (
		<SlotErrorBoundary slot={slot} resetKey={entry.def.id} fallback={() => null}>
			<CordisContext.Provider value={entry.ctx}>
				<SlotItemPlacementContext.Provider value={placement}>
					<Component ctx={entry.ctx} placement={placement} />
				</SlotItemPlacementContext.Provider>
			</CordisContext.Provider>
		</SlotErrorBoundary>
	);
}

/** Same members, any order: whether a re-measure changed anything. */
function sameSet(a: ReadonlySet<string> | null, b: ReadonlySet<string>): boolean {
	return !!a && a.size === b.size && [...b].every((id) => a.has(id));
}

const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP = 10;

/**
 * Opens the host's item menu on right-click, on the keyboard's menu key (which fires
 * `contextmenu` on the focused control) and on a touch long-press, the touch path where
 * there is no right click. A long press swallows the click that ends it.
 */
function useItemMenuGesture(open: (at: { top: number; left: number }, returnFocus: HTMLElement | null) => void) {
	const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
	const cancel = () => {
		if (press.current) clearTimeout(press.current.timer);
		press.current = null;
	};
	useEffect(() => cancel, []);
	return {
		onContextMenu(e: React.MouseEvent) {
			e.preventDefault();
			e.stopPropagation();
			cancel();
			const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			open(contextMenuPosition(e), focused);
		},
		onPointerDown(e: React.PointerEvent) {
			if (e.pointerType !== "touch") return;
			cancel();
			const { clientX: x, clientY: y } = e;
			const target = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("button, [tabindex]") : null;
			press.current = {
				x,
				y,
				timer: setTimeout(() => {
					press.current = null;
					swallowLiftClick();
					open({ top: y, left: x }, target);
				}, LONG_PRESS_MS),
			};
		},
		onPointerMove(e: React.PointerEvent) {
			if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > LONG_PRESS_SLOP) cancel();
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
	};
}

/**
 * The click a browser synthesizes when the finger lifts after a long press lands wherever
 * the menu now is: its backdrop or a row. Swallow that one click, document-wide; the next
 * touch clears the trap when the browser sent none.
 */
function swallowLiftClick(): void {
	const swallow = (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		release();
	};
	const release = () => {
		document.removeEventListener("click", swallow, true);
		document.removeEventListener("pointerdown", release, true);
	};
	document.addEventListener("click", swallow, true);
	document.addEventListener("pointerdown", release, true);
}

/**
 * An inline item inside a layout-less marker (`display: contents`): it carries the item
 * menu gesture and tells the host whether the item drew anything at all.
 */
function FramedItem<Scope>({ slot, entry, frameRef, onMenu }: {
	slot: string;
	entry: Entry<Scope>;
	frameRef: (id: string, node: HTMLElement | null) => void;
	onMenu: (id: string, placement: SlotItemPlacement, at: { top: number; left: number }, returnFocus: HTMLElement | null) => void;
}) {
	const id = entry.def.id;
	const gesture = useItemMenuGesture((at, returnFocus) => onMenu(id, "inline", at, returnFocus));
	const ref = useCallback((node: HTMLElement | null) => frameRef(id, node), [frameRef, id]);
	return (
		<span ref={ref} data-slot-item={id} style={{ display: "contents" }} {...gesture}>
			<Item slot={slot} entry={entry} placement="inline" />
		</span>
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
	/** The host's exceptions to `budget`: built-ins that show without using it up. */
	budgetExempt?: ReadonlySet<string>;
	className?: string;
	/** `span` when the items sit inside phrasing content, e.g. a group drawn inside a button row. */
	as?: "div" | "span";
	/**
	 * The host's per-item menu (right-click, menu key, long press). With it, each inline item
	 * sits in a marker so the budget counts only the items that draw something.
	 */
	onItemMenu?: (request: SlotItemMenuRequest) => void;
}

/**
 * A contribution slot: every registered item, placed by origin and user layout, each
 * isolated in its own error boundary. The host owns the bar, the order and the budget.
 * An item moving between the bar and More remounts, so it keeps no local state across.
 */
export function SlotItems<Scope>({ registry, region, scope, layout, budget, budgetExempt, className, as: Wrapper = "div", onItemMenu }: SlotItemsProps<Scope>) {
	const getEntries = useCallback(
		() => (region === undefined ? registry.list() : registry.listRegion(region)),
		[registry, region],
	);
	const entries = useSyncExternalStore(registry.subscribe, getEntries);
	const shown = entries.filter((entry) => isShown(entry, scope));
	const place = (ids: ReadonlySet<string> | null) => placeSlotItems(shown, layout, budget, budgetExempt, ids ?? undefined);
	// The measured set only moves placement when an extension item competes for the budget.
	const rendered = useRenderedItems(
		!!onItemMenu && entries.some((entry) => !isBuiltinItem(entry.def.id)),
		(ids) => place(ids).inline.map((entry) => entry.def.id).join(" "),
	);
	const { inline, overflow } = place(rendered.ids);
	const placed = useRef({ entries, inline, overflow, layout, place });
	placed.current = { entries, inline, overflow, layout, place };
	const openMenu = useCallback((id: string, placement: SlotItemPlacement, at: { top: number; left: number }, returnFocus: HTMLElement | null) => {
		const current = placed.current;
		const drawnIds = rendered.measure();
		onItemMenu?.({
			id,
			placement,
			at,
			returnFocus,
			order: sortSlotEntries(current.entries, current.layout?.order).map((entry) => entry.def.id),
			drawn: current.inline.map((entry) => entry.def.id).filter((itemId) => drawnIds.has(itemId)),
			overflow: current.overflow.map((entry) => entry.def.id),
			room: current.place(drawnIds).room,
		});
	}, [onItemMenu, rendered]);
	return (
		<Wrapper className={className ?? "flex items-center gap-1.5"} data-slot={registry.name} data-region={region}>
			{inline.map((entry) => onItemMenu
				? <FramedItem key={entry.def.id} slot={registry.name} entry={entry} frameRef={rendered.frameRef} onMenu={openMenu} />
				: <Item key={entry.def.id} slot={registry.name} entry={entry} placement="inline" />)}
			{overflow.length > 0 && <OverflowMenu slot={registry.name} entries={overflow} onMenu={onItemMenu ? openMenu : undefined} />}
		</Wrapper>
	);
}

/**
 * Which framed items draw anything. Measured after every render and whenever an item's
 * top-level nodes change, so an item that turns itself off frees its place in the budget.
 * `ids` is null until the first measurement that changes placement (every built-in counts until then).
 */
function useRenderedItems(enabled: boolean, placementKey: (ids: ReadonlySet<string> | null) => string) {
	const keyOf = useRef(placementKey);
	keyOf.current = placementKey;
	const frames = useRef(new Map<string, HTMLElement>());
	const [ids, setIds] = useState<ReadonlySet<string> | null>(null);
	const measure = useCallback(() => {
		const next = new Set<string>();
		for (const [id, node] of frames.current) if (node.firstChild) next.add(id);
		return next;
	}, []);
	const live = useRef(enabled);
	live.current = enabled;
	const update = useCallback(() => {
		if (!live.current) return;
		const next = measure();
		// A measurement that moves nothing costs no render.
		setIds((previous) => (sameSet(previous, next) || keyOf.current(previous) === keyOf.current(next) ? previous : next));
	}, [measure]);
	const observer = useRef<MutationObserver | null>(null);
	const frameRef = useCallback((id: string, node: HTMLElement | null) => {
		if (node) {
			frames.current.set(id, node);
			observer.current?.observe(node, { childList: true });
		} else frames.current.delete(id);
	}, []);
	useLayoutEffect(() => {
		if (!enabled) return;
		if (!observer.current && typeof MutationObserver !== "undefined") {
			observer.current = new MutationObserver(update);
			for (const node of frames.current.values()) observer.current.observe(node, { childList: true });
		}
		update();
	});
	useEffect(() => () => observer.current?.disconnect(), []);
	return useMemo(() => ({ ids: enabled ? ids : null, frameRef, measure }), [enabled, ids, frameRef, measure]);
}

function OverflowMenu<Scope>({ slot, entries, onMenu }: {
	slot: string;
	entries: readonly Entry<Scope>[];
	onMenu?: (id: string, placement: SlotItemPlacement, at: { top: number; left: number }, returnFocus: HTMLElement | null) => void;
}) {
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
			{open && (
				<OverflowPanel
					slot={slot}
					entries={entries}
					triggerRef={triggerRef}
					onDismiss={close}
					onMenu={onMenu && ((id, at) => {
						close();
						onMenu(id, "overflow", at, triggerRef.current);
					})}
				/>
			)}
		</div>
	);
}

/** `min-w-52`, in px: where the panel's left edge goes so its right edge meets the trigger's. */
const PANEL_MIN_WIDTH = 208;

const ROW_CONTROL = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Each row's focus target: its menu row, or, for a built-in that draws its bar form
 * because the user sent it to More, the first control in that form.
 */
function menuItems(panel: HTMLElement | null): HTMLElement[] {
	if (!panel) return [];
	return Array.from(panel.querySelectorAll<HTMLElement>("[data-slot-row]"))
		.flatMap((row) => {
			const rows = Array.from(row.querySelectorAll<HTMLElement>(MENU_ITEM));
			if (rows.length > 0) return rows;
			const control = isBuiltinItem(row.dataset.slotRow ?? "") ? row.querySelector<HTMLElement>(ROW_CONTROL) : null;
			return control ? [control] : [];
		})
		.filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");
}

function OverflowPanel<Scope>({ slot, entries, triggerRef, onDismiss, onMenu }: {
	slot: string;
	entries: readonly Entry<Scope>[];
	triggerRef: RefObject<HTMLButtonElement | null>;
	onDismiss: () => void;
	/** The row's item menu: right-click or the menu key on a row. */
	onMenu?: (id: string, at: { top: number; left: number }) => void;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	// Portaled and fixed: a bar clips its own overflow, and the task header clips its height.
	const [anchor] = useState(() => {
		const rect = triggerRef.current?.getBoundingClientRect();
		return rect ? { top: rect.bottom + 6, left: rect.right - PANEL_MIN_WIDTH } : { top: 0, left: 0 };
	});
	const { position, visible } = useViewportClamp(panelRef, anchor);
	// Focus goes back to the trigger only when it was inside the menu (Escape, a row
	// activated); a dismissal caused by focus moving elsewhere leaves it there.
	const dismiss = useCallback(() => {
		const inside = !!panelRef.current?.contains(document.activeElement);
		onDismiss();
		if (inside) triggerRef.current?.focus();
	}, [onDismiss, triggerRef]);
	useOverlayLayer(panelRef, { onDismiss: dismiss, triggerRef });
	// Not before the clamp shows the panel: focus() on a `visibility: hidden` element is a no-op.
	useEffect(() => {
		if (visible) menuItems(panelRef.current)[0]?.focus();
	}, [visible]);
	useEffect(() => {
		const panel = panelRef.current;
		for (const row of panel?.querySelectorAll<HTMLElement>("[data-slot-row]") ?? []) {
			if (row.childElementCount > 0 && !row.querySelector(MENU_ITEM) && !isBuiltinItem(row.dataset.slotRow ?? "")) {
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
	return createPortal(
		<div
			ref={panelRef}
			role="menu"
			onKeyDown={onKeyDown}
			onClick={(e) => {
				// A built-in's bar form keeps the menu open: it may open a popover of its own.
				if ((e.target as Element).closest?.(MENU_ITEM)) dismiss();
			}}
			style={{ top: position.top, left: position.left, visibility: visible ? "visible" : "hidden" }}
			className="fixed min-w-52 bg-overlay border border-edge rounded-xl shadow-2xl z-[201] py-1"
		>
			{entries.map((entry) => (
				<div
					key={entry.def.id}
					role="none"
					data-slot-row={entry.def.id}
					className={isBuiltinItem(entry.def.id) ? "flex items-center px-2 py-1" : undefined}
					onContextMenu={onMenu && ((e) => {
						e.preventDefault();
						e.stopPropagation();
						onMenu(entry.def.id, contextMenuPosition(e));
					})}
				>
					<Item slot={slot} entry={entry} placement="overflow" />
				</div>
			))}
		</div>,
		document.body,
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
