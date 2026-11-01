import { Component, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Context } from "cordis";
import Select from "../components/Select";
import { useT, type TranslationKey } from "../i18n";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { CordisContext } from "./react";
import type { RegisteredBoardView } from "./registry";

/** Built-ins label themselves with an i18n key; an extension's label is plain text. */
export function useViewLabel(): (view: RegisteredBoardView) => string {
	const t = useT();
	return (view) => (view.def.id.startsWith("builtin:") ? t(view.def.label as TranslationKey) : view.def.label);
}

const MANAGE_VIEWS = "__manage-views__";

/** "Kanban ▾" at the left end of the filter row (D13), ending in "Manage views…". The host decides whether it shows at all. */
export function BoardViewSwitcher({ views, activeId, onPick, onManage }: {
	views: readonly RegisteredBoardView[];
	activeId: string;
	onPick: (id: string) => void;
	onManage: () => void;
}) {
	const t = useT();
	const labelOf = useViewLabel();
	return (
		<div className="flex-shrink-0" data-testid="board-view-switcher">
			<Select
				value={activeId}
				options={[
					...views.map((view) => ({ value: view.def.id, label: labelOf(view) })),
					{ value: MANAGE_VIEWS, label: t("boardView.manage") },
				]}
				onChange={(value) => (value === MANAGE_VIEWS ? onManage() : onPick(value))}
				ariaLabel={t("boardView.switcherAria")}
				growList
			/>
		</div>
	);
}

/** The ghost "View options" icon; the popover's content belongs to the active view. */
export function BoardViewOptionsButton({ view }: { view: RegisteredBoardView }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const Options = view.def.Options;
	if (!Options) return null;
	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen((prev) => !prev)}
				aria-label={t("boardView.optionsAria")}
				title={t("boardView.optionsAria")}
				aria-expanded={open}
				data-testid="board-view-options"
				className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-raised-hover transition-[color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
			>
				<svg aria-hidden className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
					<path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
					<circle cx="16" cy="7" r="2" />
					<circle cx="10" cy="17" r="2" />
				</svg>
			</button>
			{open && triggerRef.current && (
				<OptionsPopover anchor={triggerRef.current} triggerRef={triggerRef} onDismiss={() => setOpen(false)}>
					<CordisContext.Provider value={view.ctx}>
						<Options ctx={view.ctx} />
					</CordisContext.Provider>
				</OptionsPopover>
			)}
		</>
	);
}

function OptionsPopover({ anchor, triggerRef, onDismiss, children }: {
	anchor: HTMLElement;
	triggerRef: React.RefObject<HTMLButtonElement | null>;
	onDismiss: () => void;
	children: ReactNode;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, right: 0 });
	useLayoutEffect(() => {
		const rect = anchor.getBoundingClientRect();
		setPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
	}, [anchor]);
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
	return createPortal(
		<div
			ref={panelRef}
			role="dialog"
			style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999 }}
			className="bg-overlay border border-edge rounded-xl shadow-xl p-3 min-w-56 max-w-[min(24rem,92vw)]"
		>
			{children}
		</div>,
		document.body,
	);
}

interface BoundaryProps {
	/** A new view id resets the boundary: the user picking another view is a retry. */
	viewId: string;
	fallback: (error: Error) => ReactNode;
	children: ReactNode;
}

/**
 * Around the active view. A crashing view falls back to Kanban with a notice,
 * and the saved choice stays as it is (spec §4.1): one bad render must not
 * rewrite the user's preference.
 */
export class BoardViewErrorBoundary extends Component<BoundaryProps, { error: Error | null; viewId: string }> {
	state = { error: null as Error | null, viewId: this.props.viewId };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	static getDerivedStateFromProps(props: BoundaryProps, state: { error: Error | null; viewId: string }) {
		return props.viewId === state.viewId ? null : { error: null, viewId: props.viewId };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(`[board-views] view ${this.props.viewId} crashed:`, error, info.componentStack);
	}

	render() {
		return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
	}
}

/** One view, rendered under the context of the plugin that registered it. */
export function BoardViewSlot({ ctx, component: View }: { ctx: Context; component: React.ComponentType<{ ctx: Context }> }) {
	return (
		<CordisContext.Provider value={ctx}>
			<View ctx={ctx} />
		</CordisContext.Provider>
	);
}
