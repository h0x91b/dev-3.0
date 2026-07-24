import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { getKeymapPreset, KEYMAP_CHANGED_EVENT, setKeymapPreset } from "../../terminal-keymaps";
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
	TmuxHintsIcon,
	ZoomPaneIcon,
} from "../TmuxIcons";

interface TaskTmuxControlsProps {
	taskId: string;
	/** Drop the layout button's text label when the inspector bar is short on width. */
	compact?: boolean;
}

type TmuxAction =
	| "splitH"
	| "splitV"
	| "newWindow"
	| "zoom"
	| "nextLayout"
	| "killPane"
	| "layoutTiled"
	| "layoutEvenH"
	| "layoutEvenV"
	| "layoutMainH"
	| "layoutMainV";

type LayoutAction = "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV";

export default function TaskTmuxControls({ taskId, compact = false }: TaskTmuxControlsProps) {
	const t = useT();
	// Hover-to-pick only makes sense on a real split with a pointer. On a narrow
	// viewport the terminal is a one-pane carousel (no hover, no visible split),
	// so Close Pane keeps its direct-kill behavior there.
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [keymapPreset, setKeymapPresetState] = useState(() => getKeymapPreset());
	const [hintsOpen, setHintsOpen] = useState(false);
	const [hintsPos, setHintsPos] = useState({ top: 0, left: 0 });
	const [hintsVisible, setHintsVisible] = useState(false);
	const hintsTriggerRef = useRef<HTMLButtonElement>(null);
	const hintsPopoverRef = useRef<HTMLDivElement>(null);
	const hintsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const [layoutOpen, setLayoutOpen] = useState(false);
	const [layoutPos, setLayoutPos] = useState({ top: 0, left: 0 });
	const [layoutVisible, setLayoutVisible] = useState(false);
	const [activeLayout, setActiveLayout] = useState<LayoutAction | null>(null);
	const layoutTriggerRef = useRef<HTMLButtonElement>(null);
	const layoutMenuRef = useRef<HTMLDivElement>(null);
	const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		function onKeymapChanged(event: Event) {
			setKeymapPresetState((event as CustomEvent).detail);
		}

		window.addEventListener(KEYMAP_CHANGED_EVENT, onKeymapChanged);
		return () => window.removeEventListener(KEYMAP_CHANGED_EVENT, onKeymapChanged);
	}, []);

	function clearHintsTimeout() {
		if (hintsTimeoutRef.current) {
			clearTimeout(hintsTimeoutRef.current);
			hintsTimeoutRef.current = null;
		}
	}

	function showHints() {
		clearHintsTimeout();
		if (!hintsOpen && hintsTriggerRef.current) {
			const rect = hintsTriggerRef.current.getBoundingClientRect();
			setHintsPos({ top: rect.bottom + 6, left: rect.right });
			setHintsVisible(false);
			setHintsOpen(true);
		}
	}

	function hideHints() {
		clearHintsTimeout();
		hintsTimeoutRef.current = setTimeout(() => {
			setHintsOpen(false);
			setHintsVisible(false);
		}, 200);
	}

	useEffect(() => clearHintsTimeout, []);

	useEscapeKey(
		() => {
			setHintsOpen(false);
			setHintsVisible(false);
		},
		{ enabled: hintsOpen },
	);

	useLayoutEffect(() => {
		if (!hintsOpen || !hintsPopoverRef.current || !hintsTriggerRef.current) {
			return;
		}

		const menu = hintsPopoverRef.current.getBoundingClientRect();
		const trigger = hintsTriggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.right - menu.width;

		if (top + menu.height > vh - pad) {
			top = trigger.top - menu.height - 6;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setHintsPos({ top, left });
		setHintsVisible(true);
	}, [hintsOpen]);

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
		if (!layoutOpen || !layoutMenuRef.current || !layoutTriggerRef.current) {
			return;
		}

		const menu = layoutMenuRef.current.getBoundingClientRect();
		const trigger = layoutTriggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.right - menu.width;

		if (top + menu.height > vh - pad) {
			top = trigger.top - menu.height - 6;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setLayoutPos({ top, left });
		setLayoutVisible(true);
	}, [layoutOpen]);

	function toggleItermCompat(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		setKeymapPreset(keymapPreset === "iterm2" ? "default" : "iterm2");
	}

	const handleTmuxAction = (action: TmuxAction) => async (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (action === "killPane") {
			let count = 0;
			try {
				const result = await api.request.tmuxPaneCount({ taskId });
				count = result.count;
			} catch {
				count = 0;
			}
			if (count <= 1) {
				// Closing the last pane tears down the whole tmux session — confirm first.
				let confirmed = false;
				try {
					confirmed = await confirm({
						title: t("tmux.closePaneConfirmTitle"),
						message: t("tmux.closePaneConfirmMessage"),
						danger: true,
					});
				} catch {
					confirmed = false;
				}
				if (!confirmed) return;
				api.request.tmuxAction({ taskId, action, force: true }).catch(() => {});
				return;
			}
		}
		api.request.tmuxAction({ taskId, action }).catch(() => {});
	};

	// The red Close Pane button. On a real desktop split it opens the two-step
	// picker (an overlay over the terminal in TaskTerminal); on narrow viewports it
	// falls back to the direct kill of the visible pane (reusing the last-pane
	// teardown confirm baked into handleTmuxAction("killPane")).
	const handleClosePane = (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (narrow) {
			void handleTmuxAction("killPane")(event);
			return;
		}
		startClosePanePicker(taskId);
	};

	// Cycling steps through tmux's own layout rotation, so the toolbar can no longer
	// know which named preset is active — clear the highlight to avoid lying about it.
	const cycleLayout = (event: ReactMouseEvent<HTMLButtonElement>) => {
		setActiveLayout(null);
		void handleTmuxAction("nextLayout")(event);
	};

	const applyLayout = (action: LayoutAction) => (event: ReactMouseEvent<HTMLButtonElement>) => {
		setActiveLayout(action);
		setLayoutOpen(false);
		setLayoutVisible(false);
		void handleTmuxAction(action)(event);
	};

	const tmuxBtnClass = "tmux-anim px-1.5 py-1 rounded text-[0.625rem] font-medium transition-colors text-accent hover:bg-accent/20 bg-accent/10 border border-accent/25 flex items-center gap-1";
	// New window is a "create" action — green, to set it apart from the blue pane splits.
	const tmuxNewWindowBtnClass = "tmux-anim px-1.5 py-1 rounded text-[0.625rem] font-medium transition-colors text-success hover:bg-success/20 bg-success/10 border border-success/35 flex items-center gap-1";
	const tmuxIconBtnClass = "tmux-anim px-1.5 py-1 rounded text-fg-muted hover:text-fg-2 hover:bg-elevated border border-edge transition-colors flex items-center justify-center flex-shrink-0";
	const tmuxSvgClass = "w-4 h-4";
	const popoverKbd = "font-mono text-xs text-fg-2 min-w-[3.5rem]";
	const popoverDesc = "text-xs text-fg-3";
	const popoverSection = "text-[0.625rem] text-fg-muted uppercase tracking-wider font-semibold mb-1.5";

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
			<div className="flex items-center gap-1.5 flex-shrink-0">
				<Tooltip content={t("tmux.splitHDesc")} detail={t("ttip.tmux.splitH")}>
					<button className={tmuxBtnClass} onClick={handleTmuxAction("splitH")} aria-label={t("tmux.splitHDesc")}>
						<SplitHIcon className={tmuxSvgClass} />
					</button>
				</Tooltip>
				<Tooltip content={t("tmux.splitVDesc")} detail={t("ttip.tmux.splitV")}>
					<button className={tmuxBtnClass} onClick={handleTmuxAction("splitV")} aria-label={t("tmux.splitVDesc")}>
						<SplitVIcon className={tmuxSvgClass} />
					</button>
				</Tooltip>
				<Tooltip content={t("tmux.newWindowDesc")}>
					<button className={tmuxNewWindowBtnClass} onClick={handleTmuxAction("newWindow")} aria-label={t("tmux.newWindowDesc")}>
						<NewWindowIcon className={tmuxSvgClass} />
					</button>
				</Tooltip>

				<div
					className="flex items-stretch rounded text-accent bg-accent/10 border border-accent/25 overflow-hidden"
					onMouseEnter={showLayout}
					onMouseLeave={hideLayout}
				>
					<Tooltip content={t("tmux.nextLayoutDesc")} detail={t("ttip.tmux.nextLayout")}>
						<button
							className="tmux-anim px-1.5 py-1 text-[0.625rem] font-medium transition-colors hover:bg-accent/20 flex items-center gap-1"
							onClick={cycleLayout}
							aria-label={t("tmux.nextLayoutDesc")}
						>
							{cycleIcon}
							{!compact && <span>tmux layout</span>}
						</button>
					</Tooltip>
					<Tooltip content={t("tmux.chooseLayout")} detail={t("ttip.tmux.chooseLayout")}>
						<button
							ref={layoutTriggerRef}
							className="px-1 py-1 transition-colors hover:bg-accent/20 border-l border-accent/25 flex items-center justify-center"
							onClick={(event) => {
								event.stopPropagation();
								showLayout();
							}}
							aria-label={t("tmux.chooseLayout")}
							aria-haspopup="menu"
							aria-expanded={layoutOpen}
						>
							<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
								<path d="M6 9 L12 15 L18 9" stroke="currentColor" />
							</svg>
						</button>
					</Tooltip>
				</div>

				<Tooltip content={t("tmux.zoomDesc")} detail={t("ttip.tmux.zoom")}>
					<button className={tmuxBtnClass} onClick={handleTmuxAction("zoom")} aria-label={t("tmux.zoomDesc")}>
						<ZoomPaneIcon className={tmuxSvgClass} />
					</button>
				</Tooltip>
				<button
					ref={hintsTriggerRef}
					className={tmuxIconBtnClass}
					onClick={(event) => {
						event.stopPropagation();
						setHintsOpen((open) => !open);
					}}
					onMouseEnter={showHints}
					onMouseLeave={hideHints}
					title={t("tmux.title")}
					aria-label={t("tmux.title")}
				>
					<TmuxHintsIcon className="w-3.5 h-3.5" />
				</button>

				<div className="w-px self-stretch bg-edge mx-0.5" aria-hidden="true" />

				<Tooltip content={t("tmux.closePaneDesc")} detail={t("ttip.tmux.closePane")}>
					<button
						className={`${tmuxBtnClass} text-danger hover:bg-danger/20 bg-danger/10 border-danger/25`}
						onClick={handleClosePane}
						aria-label={t("tmux.closePaneDesc")}
					>
						<ClosePaneIcon className={tmuxSvgClass} />
					</button>
				</Tooltip>
			</div>

			{layoutOpen && createPortal(
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
						<span className="flex-shrink-0 text-fg-2">
							{cycleIcon}
						</span>
						<span className="text-xs flex-1 text-fg-2">{t("tmux.nextLayoutDesc")}</span>
						<kbd className="font-mono text-[0.625rem] text-fg-muted flex-shrink-0">⌃B ␣</kbd>
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
								<kbd className="font-mono text-[0.625rem] text-fg-muted flex-shrink-0">{shortcut}</kbd>
							</button>
						);
					})}
				</div>,
				document.body,
			)}

			{hintsOpen && createPortal(
				<div
					ref={hintsPopoverRef}
					className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-4 min-w-[18.75rem]"
					style={{ top: hintsPos.top, left: hintsPos.left, visibility: hintsVisible ? "visible" : "hidden" }}
					onMouseEnter={showHints}
					onMouseLeave={hideHints}
				>
					<div className="text-xs font-semibold text-fg mb-3">{t("tmux.title")}</div>

					<div className={popoverSection}>{t("tmux.panes")}</div>
					<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
						<kbd className={popoverKbd}>⌃B -</kbd><span className={popoverDesc}>{t("tmux.splitHDesc")}</span>
						<kbd className={popoverKbd}>⌃B |</kbd><span className={popoverDesc}>{t("tmux.splitVDesc")}</span>
						<kbd className={popoverKbd}>⌃B z</kbd><span className={popoverDesc}>{t("tmux.zoomDesc")}</span>
						<kbd className={popoverKbd}>⌃B ␣</kbd><span className={popoverDesc}>{t("tmux.nextLayoutDesc")}</span>
						<kbd className={popoverKbd}>⌃B x</kbd><span className={popoverDesc}>{t("tmux.closePaneDesc")}</span>
						<kbd className={popoverKbd}>⌃D</kbd><span className={popoverDesc}>{t("tmux.closePaneEofDesc")}</span>
						<kbd className={popoverKbd}>⌃B M-1</kbd><span className={popoverDesc}>{t("tmux.layoutEvenHDesc")}</span>
						<kbd className={popoverKbd}>⌃B M-2</kbd><span className={popoverDesc}>{t("tmux.layoutEvenVDesc")}</span>
						<kbd className={popoverKbd}>⌃B M-3</kbd><span className={popoverDesc}>{t("tmux.layoutMainHDesc")}</span>
						<kbd className={popoverKbd}>⌃B M-4</kbd><span className={popoverDesc}>{t("tmux.layoutMainVDesc")}</span>
						<kbd className={popoverKbd}>⌃B M-5</kbd><span className={popoverDesc}>{t("tmux.layoutTiledDesc")}</span>
						<span className={`${popoverDesc} col-span-2 mt-1.5 text-fg-muted`}>{t("tmux.selectPaneDesc")}</span>
						<span className={`${popoverDesc} col-span-2 text-fg-muted`}>{t("tmux.resizePaneDesc")}</span>
					</div>

					<div className="border-t border-edge mt-3 pt-3">
						<div className={popoverSection}>{t("tmux.keyboardMode")}</div>
						<button
							onClick={toggleItermCompat}
							className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
								keymapPreset === "iterm2"
									? "bg-accent/10 border border-accent/20"
									: "hover:bg-elevated border border-transparent"
							}`}
						>
							<div className={`w-3.5 h-3.5 rounded flex items-center justify-center flex-shrink-0 border transition-colors ${
								keymapPreset === "iterm2" ? "border-accent bg-accent" : "border-edge-active"
							}`}>
								{keymapPreset === "iterm2" && (
									<svg width="7" height="6" viewBox="0 0 7 6" fill="none">
										<path d="M0.5 3L2.5 5L6.5 1" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
									</svg>
								)}
							</div>
							<div>
								<div className={`text-xs font-medium ${keymapPreset === "iterm2" ? "text-accent" : "text-fg-2"}`}>
									{t("settings.keymapIterm2")}
								</div>
								<div className="text-[0.625rem] text-fg-muted mt-0.5">{t("settings.keymapIterm2Desc")}</div>
							</div>
						</button>
					</div>
				</div>,
				document.body,
			)}
		</>
	);
}
