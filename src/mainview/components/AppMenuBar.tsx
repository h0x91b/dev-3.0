import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApplicationMenuItemConfig } from "electrobun/bun";
import { buildApplicationMenu, isComingSoonAction, type MenuContext } from "../../shared/application-menu";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { BROWSER_HANDLED_ACTIONS } from "../menuRouter";
import { isMac } from "../utils/platform";
import { useT } from "../i18n";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

/**
 * Browser-mode application menu bar.
 *
 * In the Electrobun desktop shell the native macOS/Linux menu bar owns the full
 * action taxonomy. In Remote Access / browser mode that surface does not exist,
 * so we render it ourselves from the SAME `buildApplicationMenu(context)` source
 * the native menu is built from, and dispatch through the SAME `handleMenuAction`
 * router (via the `onAction` prop). This component must only be mounted when
 * `isElectrobun === false` (see `App.tsx`).
 *
 * Filtering (see `buildBrowserMenu`): native-only `role` items (clipboard, window,
 * quit) and any action the browser can't run (handled only by the bun-side menu
 * handler) or that is still on the roadmap are dropped, so the bar lists only what
 * this build can actually do. Context-disabled items (e.g. task actions with no
 * task selected) render greyed, mirroring the native menu.
 */

type MenuNode =
	| { kind: "separator" }
	| { kind: "item"; label: string; action: string; accelerator?: string; enabled: boolean }
	| { kind: "submenu"; label: string; children: MenuNode[] };

/** Narrow `ApplicationMenuItemConfig` accessors without fighting its union type. */
function asAny(item: ApplicationMenuItemConfig): {
	type?: string;
	label?: string;
	action?: string;
	accelerator?: string;
	role?: string;
	enabled?: boolean;
	submenu?: ApplicationMenuItemConfig[];
} {
	return item as never;
}

/** Strip leading/trailing separators and collapse consecutive ones. */
function cleanSeparators(nodes: MenuNode[]): MenuNode[] {
	const out: MenuNode[] = [];
	for (const node of nodes) {
		if (node.kind === "separator") {
			if (out.length === 0 || out[out.length - 1].kind === "separator") continue;
		}
		out.push(node);
	}
	while (out.length && out[out.length - 1].kind === "separator") out.pop();
	return out;
}

function normalize(items: ApplicationMenuItemConfig[]): MenuNode[] {
	const nodes: MenuNode[] = [];
	for (const raw of items) {
		const item = asAny(raw);
		if (item.type === "separator" || item.type === "divider") {
			nodes.push({ kind: "separator" });
			continue;
		}
		if (item.action) {
			// Drop actions the browser can't execute, and roadmap placeholders.
			if (!BROWSER_HANDLED_ACTIONS.has(item.action)) continue;
			if (isComingSoonAction(item.action)) continue;
			nodes.push({
				kind: "item",
				label: item.label ?? "",
				action: item.action,
				accelerator: item.accelerator,
				enabled: item.enabled !== false,
			});
			continue;
		}
		if (item.submenu && item.label) {
			const children = cleanSeparators(normalize(item.submenu));
			if (children.some((c) => c.kind !== "separator")) {
				nodes.push({ kind: "submenu", label: item.label, children });
			}
			continue;
		}
		// role-only items (undo/copy/quit/minimize/…) and label-only nodes: drop.
	}
	return nodes;
}

/**
 * Pure transform from a `MenuContext` to the browser menu tree. Exported for
 * unit testing without a DOM.
 */
export function buildBrowserMenu(context: MenuContext): MenuNode[] {
	return cleanSeparators(normalize(buildApplicationMenu(context)));
}

/** Format a single-char native accelerator as a platform shortcut hint. */
function formatAccelerator(accel: string): string {
	const prefix = isMac() ? "⌘" : "Ctrl+";
	return `${prefix}${accel.length === 1 ? accel.toUpperCase() : accel}`;
}

interface DropdownProps {
	nodes: MenuNode[];
	onRun: (action: string) => void;
	/** Flyout direction for nested submenus. */
	side?: "down" | "right";
}

/** Renders the rows of one dropdown / flyout panel. */
function Dropdown({ nodes, onRun, side = "down" }: DropdownProps) {
	const [openSub, setOpenSub] = useState<number | null>(null);
	return (
		<div
			role="menu"
			className={`absolute z-50 min-w-[13rem] py-1 bg-overlay border border-edge rounded-md shadow-lg ${
				side === "right" ? "left-full top-0 -mt-1 ml-0.5" : "left-0 top-full mt-1"
			}`}
		>
			{nodes.map((node, i) => {
				if (node.kind === "separator") {
					return <div key={`sep-${i}`} role="separator" className="my-1 border-t border-edge" />;
				}
				if (node.kind === "submenu") {
					const open = openSub === i;
					return (
						<div key={`sub-${i}`} className="relative" onMouseEnter={() => setOpenSub(i)} onMouseLeave={() => setOpenSub((p) => (p === i ? null : p))}>
							<div
								role="menuitem"
								aria-haspopup="menu"
								aria-expanded={open}
								className="flex items-center justify-between gap-6 px-3 py-1.5 text-[13px] text-fg-2 hover:bg-raised-hover hover:text-fg cursor-default"
							>
								<span>{node.label}</span>
								<span className="text-fg-muted">{"›"}</span>
							</div>
							{open && <Dropdown nodes={node.children} onRun={onRun} side="right" />}
						</div>
					);
				}
				// item
				const disabled = !node.enabled;
				return (
					<button
						key={`item-${node.action}`}
						type="button"
						role="menuitem"
						aria-disabled={disabled}
						disabled={disabled}
						onClick={() => !disabled && onRun(node.action)}
						className={`w-full flex items-center justify-between gap-6 px-3 py-1.5 text-left text-[13px] ${
							disabled ? "text-fg-muted/40 cursor-default" : "text-fg-2 hover:bg-raised-hover hover:text-fg"
						}`}
					>
						<span className="truncate">{node.label}</span>
						{node.accelerator && <span className="text-fg-muted text-xs shrink-0">{formatAccelerator(node.accelerator)}</span>}
					</button>
				);
			})}
		</div>
	);
}

interface AppMenuBarProps {
	context: MenuContext;
	onAction: (action: string) => void;
}

export default function AppMenuBar({ context, onAction }: AppMenuBarProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const menus = useMemo(() => buildBrowserMenu(context), [context]);
	// The wide browser menu is an app-level overflow surface. On narrow screens
	// GlobalHeader owns the single More action sheet and its touch command-palette
	// entry, so rendering another row would only consume scarce vertical space.
	const [openIndex, setOpenIndex] = useState<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	const close = useCallback(() => setOpenIndex(null), []);

	const run = useCallback(
		(action: string) => {
			close();
			onAction(action);
		},
		[close, onAction],
	);

	// Close on Escape or click outside.
	useEffect(() => {
		if (openIndex === null) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") close();
		}
		function onClick(e: MouseEvent) {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
		}
		window.addEventListener("keydown", onKey);
		window.addEventListener("mousedown", onClick);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onClick);
		};
	}, [openIndex, close]);

	if (menus.length === 0 || narrow) return null;

	const topLevel = menus.filter((m): m is Extract<MenuNode, { kind: "submenu" }> => m.kind === "submenu");

	return (
		<div ref={rootRef} role="menubar" aria-label={t("menubar.label")} data-collapse-on-compose className="relative flex items-center h-8 px-1 gap-0.5 bg-base border-b border-edge shrink-0">
			{topLevel.map((menu, i) => {
				const open = openIndex === i;
				return (
					<div key={menu.label} className="relative">
						<button
							type="button"
							role="menuitem"
							aria-haspopup="menu"
							aria-expanded={open}
							onClick={() => setOpenIndex(open ? null : i)}
							onMouseEnter={() => setOpenIndex((p) => (p === null ? p : i))}
							className={`px-2.5 h-6 rounded text-[13px] leading-none ${open ? "bg-elevated text-fg" : "text-fg-3 hover:text-fg hover:bg-elevated"}`}
						>
							{menu.label}
						</button>
						{open && <Dropdown nodes={menu.children} onRun={run} />}
					</div>
				);
			})}
		</div>
	);
}
