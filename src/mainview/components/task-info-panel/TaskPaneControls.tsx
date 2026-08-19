import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "../MobileBoardCarousel";
import { startClosePanePicker } from "../../close-pane-picker";
import Tooltip from "../Tooltip";
import {
	ClosePaneIcon,
	CycleLayoutIcon,
	LayoutEvenHIcon,
	LayoutEvenVIcon,
	LayoutMainHIcon,
	LayoutMainVIcon,
	LayoutTiledIcon,
	NewWindowIcon,
	SplitHIcon,
	SplitVIcon,
	ZoomPaneIcon,
} from "../TmuxIcons";
import type { TaskPaneState } from "../../../shared/task-panes";
import { taskPaneSupports } from "../../../shared/task-panes";
import { currentNativePaneFocus } from "../../native-pane-focus";
import { fetchPaneState, runPaneAction, subscribePaneState } from "../../pane-state-bus";
import { toast } from "../../toast";

interface TaskPaneControlsProps {
	taskId: string;
	/** Drop the layout button's text label when the inspector bar is short on width. */
	compact?: boolean;
}

type PaneAction =
	| "splitH"
	| "splitV"
	| "newWindow"
	| "zoom"
	| "nextLayout"
	| "close"
	| "layoutTiled"
	| "layoutEvenH"
	| "layoutEvenV"
	| "layoutMainH"
	| "layoutMainV";

type LayoutAction = "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV";

/** Reconciliation only: every action delivers its own state through the bus. */
const PANE_STATE_POLL_MS = 3000;

export default function TaskPaneControls({ taskId, compact = false }: TaskPaneControlsProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [paneState, setPaneState] = useState<TaskPaneState | null>(null);
	// An action is in flight. Set before awaiting, so the click is acknowledged on the
	// next rendered frame and a second click cannot start a duplicate mutation.
	const [actionBusy, setActionBusy] = useState(false);
	const actionBusyRef = useRef(false);

	const [layoutOpen, setLayoutOpen] = useState(false);
	const [layoutPos, setLayoutPos] = useState({ top: 0, left: 0 });
	const [layoutVisible, setLayoutVisible] = useState(false);
	const [activeLayout, setActiveLayout] = useState<LayoutAction | null>(null);
	const layoutTriggerRef = useRef<HTMLButtonElement>(null);
	const layoutMenuRef = useRef<HTMLDivElement>(null);
	const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Every state arrival — this component's poll, the canvas's poll, or any action's
	// own response — reaches us through the bus, so both surfaces move together.
	useEffect(() => subscribePaneState(taskId, setPaneState), [taskId]);

	useEffect(() => {
		const fetch = () => { void fetchPaneState(taskId).catch(() => {}); };
		fetch();
		const timer = setInterval(fetch, PANE_STATE_POLL_MS);
		return () => clearInterval(timer);
	}, [taskId]);

	function clearLayoutTimeout() {
		if (layoutTimeoutRef.current) {
			clearTimeout(layoutTimeoutRef.current);
			layoutTimeoutRef.current = null;
		}
	}

	function showLayout() {
		clearLayoutTimeout();
		if (!layoutOpen && layoutTriggerRef.current) {
			const rect = layoutTriggerRef.current.getBoundingClientRect();
			setLayoutPos({ top: rect.bottom + 6, left: rect.right });
			setLayoutVisible(false);
			setLayoutOpen(true);
		}
	}

	function hideLayout() {
		clearLayoutTimeout();
		layoutTimeoutRef.current = setTimeout(() => {
			setLayoutOpen(false);
			setLayoutVisible(false);
		}, 200);
	}

	useEffect(() => clearLayoutTimeout, []);

	useEscapeKey(
		() => {
			setLayoutOpen(false);
			setLayoutVisible(false);
		},
		{ enabled: layoutOpen },
	);

	useLayoutEffect(() => {
		if (!layoutOpen || !layoutMenuRef.current || !layoutTriggerRef.current) return;
		const menu = layoutMenuRef.current.getBoundingClientRect();
		const trigger = layoutTriggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;
		let top = trigger.bottom + 6;
		let left = trigger.right - menu.width;
		if (top + menu.height > vh - pad) top = trigger.top - menu.height - 6;
		if (left + menu.width > vw - pad) left = vw - menu.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;
		setLayoutPos({ top, left });
		setLayoutVisible(true);
	}, [layoutOpen]);

	/** Re-read pane state after any mutating action so capabilities stay fresh. */
	function refreshState() {
		void fetchPaneState(taskId).catch(() => {});
	}

	/**
	 * Hold the controls for the duration of one action. The flag is a ref as well as
	 * state because two clicks in the same frame would both read a stale `actionBusy`.
	 */
	function withBusy<T>(run: () => Promise<T>): Promise<T | undefined> {
		if (actionBusyRef.current) return Promise.resolve(undefined);
		actionBusyRef.current = true;
		setActionBusy(true);
		return run().finally(() => {
			actionBusyRef.current = false;
			setActionBusy(false);
		});
	}

	const handleAction = (action: PaneAction) => async (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (action === "newWindow") {
			api.request.tmuxNewWindow({ taskId }).catch(() => {});
			return;
		}
		if (action === "close") {
			const closeTarget = paneState?.backend === "native" ? currentNativePaneFocus(taskId) ?? undefined : undefined;
			void withBusy(() => runPaneAction(taskId, { kind: "close", paneId: closeTarget }).catch(() => {}).finally(refreshState));
			return;
		}
		// Native focus is client-local, so the viewer tells us which pane to act on;
		// a tmux pane id would be meaningless here, hence native-only.
		const target = paneState?.backend === "native" ? currentNativePaneFocus(taskId) ?? undefined : undefined;
		const actionMap: Record<string, import("../../../shared/task-panes").TaskPaneAction> = {
			splitH: { kind: "splitH", paneId: target },
			splitV: { kind: "splitV", paneId: target },
			zoom: { kind: "zoom", mode: "toggle", paneId: target },
			nextLayout: { kind: "layoutCycle" },
			layoutTiled: { kind: "layoutPreset", preset: "tiled" },
			layoutEvenH: { kind: "layoutPreset", preset: "evenH" },
			layoutEvenV: { kind: "layoutPreset", preset: "evenV" },
			layoutMainH: { kind: "layoutPreset", preset: "mainH" },
			layoutMainV: { kind: "layoutPreset", preset: "mainV" },
		};
		const paneAction = actionMap[action];
		if (paneAction) {
			void withBusy(() =>
				runPaneAction(taskId, paneAction).catch((err) =>
					toast.error(t("panes.actionFailed", { error: String(err) }), { taskId }),
				),
			);
		}
	};

	const handleClosePane = (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (narrow) {
			void handleAction("close")(event);
			return;
		}
		startClosePanePicker(taskId);
	};

	const cycleLayout = (event: ReactMouseEvent<HTMLButtonElement>) => {
		setActiveLayout(null);
		void handleAction("nextLayout")(event);
	};

	const applyLayout = (action: LayoutAction) => (event: ReactMouseEvent<HTMLButtonElement>) => {
		setActiveLayout(action);
		setLayoutOpen(false);
		setLayoutVisible(false);
		void handleAction(action)(event);
	};

	// Capability checks (fall back to permissive defaults while state loads).
	const supportsSplit = paneState === null || taskPaneSupports(paneState, "split");
	const showNewWindow = paneState !== null && taskPaneSupports(paneState, "newWindow");
	const isNative = paneState?.backend === "native";

	// Layout, zoom and close only mean anything once the task has a second pane —
	// a single-pane terminal shows just split / new window / shortcuts.
	const multiPane = (paneState?.panes.length ?? 0) > 1;

	// An in-flight action withholds every mutating control, not just the one
	// clicked: they all rewrite the same tree.
	const canSplit = supportsSplit && !actionBusy;
	const canZoom = !actionBusy;
	const canClose = !actionBusy;
	const layoutDisabled = actionBusy;

	const tmuxBtnClass = "tmux-anim px-1.5 py-1 rounded text-dense font-medium transition-colors text-accent hover:bg-accent/20 bg-accent/10 border border-accent/25 flex items-center gap-1";
	const tmuxBtnDisabledClass = "px-1.5 py-1 rounded text-dense font-medium text-fg-muted bg-elevated/50 border border-edge/50 flex items-center gap-1 cursor-not-allowed opacity-50";
	const tmuxNewWindowBtnClass = "tmux-anim px-1.5 py-1 rounded text-dense font-medium transition-colors text-success hover:bg-success/20 bg-success/10 border border-success/35 flex items-center gap-1";
	const tmuxSvgClass = "w-4 h-4";

	const cycleIcon: ReactNode = <CycleLayoutIcon className={tmuxSvgClass} />;

	const layoutIcons: Record<LayoutAction, ReactNode> = {
		layoutTiled: <LayoutTiledIcon className={tmuxSvgClass} />,
		layoutEvenH: <LayoutEvenHIcon className={tmuxSvgClass} />,
		layoutEvenV: <LayoutEvenVIcon className={tmuxSvgClass} />,
		layoutMainH: <LayoutMainHIcon className={tmuxSvgClass} />,
		layoutMainV: <LayoutMainVIcon className={tmuxSvgClass} />,
	};

	const layouts: { action: LayoutAction; descKey: Parameters<typeof t>[0]; shortcut: string }[] = [
		{ action: "layoutTiled", descKey: "tmux.layoutTiledDesc", shortcut: "⌃B M-5" },
		{ action: "layoutEvenH", descKey: "tmux.layoutEvenHDesc", shortcut: "⌃B M-1" },
		{ action: "layoutEvenV", descKey: "tmux.layoutEvenVDesc", shortcut: "⌃B M-2" },
		{ action: "layoutMainH", descKey: "tmux.layoutMainHDesc", shortcut: "⌃B M-3" },
		{ action: "layoutMainV", descKey: "tmux.layoutMainVDesc", shortcut: "⌃B M-4" },
	];

	return (
		<>
			<div className="flex items-center gap-1.5 flex-shrink-0" aria-busy={actionBusy}>
				<Tooltip content={t("tmux.splitHDesc")} detail={t("ttip.tmux.splitH")}>
					<button
						className={canSplit ? tmuxBtnClass : tmuxBtnDisabledClass}
						disabled={!canSplit}
						onClick={canSplit ? handleAction("splitH") : undefined}
						aria-label={t("tmux.splitHDesc")}
					>
						<SplitHIcon className={tmuxSvgClass} />
					</button>
				</Tooltip>
				<Tooltip content={t("tmux.splitVDesc")} detail={t("ttip.tmux.splitV")}>
					<button
						className={canSplit ? tmuxBtnClass : tmuxBtnDisabledClass}
						disabled={!canSplit}
						onClick={canSplit ? handleAction("splitV") : undefined}
						aria-label={t("tmux.splitVDesc")}
					>
						<SplitVIcon className={tmuxSvgClass} />
					</button>
				</Tooltip>

				{showNewWindow && (
					<Tooltip content={t("tmux.newWindowDesc")}>
						<button
							className={tmuxNewWindowBtnClass}
							onClick={(e) => { e.stopPropagation(); api.request.tmuxNewWindow({ taskId }).catch(() => {}); }}
							aria-label={t("tmux.newWindowDesc")}
						>
							<NewWindowIcon className={tmuxSvgClass} />
						</button>
					</Tooltip>
				)}

				{multiPane && (
					<Tooltip content={t("tmux.nextLayoutDesc")} detail={t("ttip.tmux.nextLayout")}>
						<div
							className={`flex items-stretch rounded ${layoutDisabled ? "opacity-50 cursor-not-allowed" : "text-accent bg-accent/10 border border-accent/25"} overflow-hidden`}
							onMouseEnter={showLayout}
							onMouseLeave={hideLayout}
						>
							<button
								className={`tmux-anim px-1.5 py-1 text-dense font-medium transition-colors ${layoutDisabled ? "text-fg-muted bg-elevated/50 border border-edge/50 cursor-not-allowed" : "text-accent hover:bg-accent/20"} flex items-center gap-1`}
								disabled={layoutDisabled}
								onClick={!layoutDisabled ? cycleLayout : undefined}
								aria-label={t("tmux.nextLayoutDesc")}
							>
								{cycleIcon}
								{!compact && <span>{t("panes.layoutLabel")}</span>}
							</button>
							<button
								ref={layoutTriggerRef}
								className="px-1 py-1 transition-colors hover:bg-accent/20 border-l border-accent/25 flex items-center justify-center"
								disabled={actionBusy}
								onClick={(event) => {
									event.stopPropagation();
									showLayout();
								}}
								aria-label={t("panes.chooseLayout")}
								aria-haspopup="menu"
								aria-expanded={layoutOpen}
							>
								<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
									<path d="M6 9 L12 15 L18 9" stroke="currentColor" />
								</svg>
							</button>
						</div>
					</Tooltip>
				)}

				{multiPane && (
					<Tooltip content={t("tmux.zoomDesc")} detail={t("ttip.tmux.zoom")}>
						<button
							className={canZoom ? tmuxBtnClass : tmuxBtnDisabledClass}
							disabled={!canZoom}
							onClick={canZoom ? handleAction("zoom") : undefined}
							aria-label={t("tmux.zoomDesc")}
						>
							<ZoomPaneIcon className={tmuxSvgClass} />
						</button>
					</Tooltip>
				)}

				{multiPane && (
					<>
						<div className="w-px self-stretch bg-edge mx-0.5" aria-hidden="true" />

						<Tooltip content={t("tmux.closePaneDesc")} detail={t("ttip.tmux.closePane")}>
							<button
								className={`${canClose ? tmuxBtnClass : tmuxBtnDisabledClass} ${canClose ? "text-danger hover:bg-danger/20 bg-danger/10 border-danger/25" : ""}`}
								disabled={!canClose}
								onClick={canClose ? handleClosePane : undefined}
								aria-label={t("tmux.closePaneDesc")}
							>
								<ClosePaneIcon className={tmuxSvgClass} />
							</button>
						</Tooltip>
					</>
				)}
			</div>

			{multiPane && layoutOpen && createPortal(
				<div
					ref={layoutMenuRef}
					role="menu"
					className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-2 min-w-[15rem]"
					style={{ top: layoutPos.top, left: layoutPos.left, visibility: layoutVisible ? "visible" : "hidden" }}
					onMouseEnter={showLayout}
					onMouseLeave={hideLayout}
				>
					<div className="text-xs font-semibold text-fg px-1.5 pt-1 pb-2">{t("tmux.layoutMenuTitle")}</div>
					<button
						role="menuitem"
						onClick={(event) => {
							setLayoutOpen(false);
							setLayoutVisible(false);
							cycleLayout(event);
						}}
						className="tmux-anim w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-elevated border border-transparent"
					>
						<span className="flex-shrink-0 text-fg-2">{cycleIcon}</span>
						<span className="text-xs flex-1 text-fg-2">{t("tmux.nextLayoutDesc")}</span>
						{!isNative && <kbd className="font-mono text-dense text-fg-muted flex-shrink-0">⌃B ␣</kbd>}
					</button>
					<div className="my-1 border-t border-edge" />
					{layouts.map(({ action, descKey, shortcut }) => {
						const active = activeLayout === action;
						return (
							<button
								key={action}
								role="menuitemradio"
								aria-checked={active}
								onClick={applyLayout(action)}
								className={`tmux-anim w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors ${
									active ? "bg-accent/10 border border-accent/20" : "hover:bg-elevated border border-transparent"
								}`}
							>
								<span className={`flex-shrink-0 ${active ? "text-accent" : "text-fg-2"}`}>
									{layoutIcons[action]}
								</span>
								<span className={`text-xs flex-1 ${active ? "text-accent font-medium" : "text-fg-2"}`}>{t(descKey)}</span>
								{active && (
									<svg className="w-3.5 h-3.5 text-accent flex-shrink-0" viewBox="0 0 16 16" fill="none">
										<path d="M3 8 L6.5 11.5 L13 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
									</svg>
								)}
								{!isNative && <kbd className="font-mono text-dense text-fg-muted flex-shrink-0">{shortcut}</kbd>}
							</button>
						);
					})}
				</div>,
				document.body,
			)}

		</>
	);
}
