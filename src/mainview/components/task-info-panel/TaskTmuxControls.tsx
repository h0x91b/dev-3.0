import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { getKeymapPreset, KEYMAP_CHANGED_EVENT, setKeymapPreset } from "../../terminal-keymaps";

interface TaskTmuxControlsProps {
	taskId: string;
}

type TmuxAction =
	| "splitH"
	| "splitV"
	| "zoom"
	| "nextLayout"
	| "killPane"
	| "layoutTiled"
	| "layoutEvenH"
	| "layoutEvenV"
	| "layoutMainH"
	| "layoutMainV";

type LayoutAction = "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV";

export default function TaskTmuxControls({ taskId }: TaskTmuxControlsProps) {
	const t = useT();
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

	useEffect(() => {
		if (!hintsOpen) {
			return;
		}

		function handleKey(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setHintsOpen(false);
				setHintsVisible(false);
			}
		}

		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [hintsOpen]);

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

	useEffect(() => {
		if (!layoutOpen) {
			return;
		}

		function handleKey(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setLayoutOpen(false);
				setLayoutVisible(false);
			}
		}

		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [layoutOpen]);

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

	const tmuxBtnClass = "px-1.5 py-1 rounded text-[0.625rem] font-medium transition-colors text-accent hover:bg-accent/20 bg-accent/10 border border-accent/25 flex items-center gap-1";
	const tmuxIconBtnClass = "px-1.5 py-1 rounded text-fg-muted hover:text-fg-2 hover:bg-elevated border border-edge transition-colors flex items-center justify-center flex-shrink-0";
	const tmuxSvgClass = "w-4 h-4";
	const svgProps = {
		className: tmuxSvgClass,
		viewBox: "0 0 24 24",
		fill: "none",
		strokeWidth: 1.5,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	};
	const popoverKbd = "font-mono text-xs text-fg-2 min-w-[3.5rem]";
	const popoverDesc = "text-xs text-fg-3";
	const popoverSection = "text-[0.625rem] text-fg-muted uppercase tracking-wider font-semibold mb-1.5";

	const cycleIcon: ReactNode = (
		<>
			<rect x="2" y="10" width="8" height="6" rx="1" stroke="currentColor" />
			<rect x="14" y="10" width="8" height="6" rx="1" stroke="currentColor" />
			<path d="M 6 8 C 8 3, 16 3, 18 8" className="text-success" stroke="currentColor" />
			<path d="M 15 6 L 18 8 L 21 6" className="text-success" stroke="currentColor" />
			<path d="M 18 18 C 16 23, 8 23, 6 18" className="text-success" stroke="currentColor" />
			<path d="M 9 20 L 6 18 L 3 20" className="text-success" stroke="currentColor" />
		</>
	);

	const layoutIcons: Record<LayoutAction, ReactNode> = {
		layoutTiled: (
			<>
				<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" />
				<line x1="12" y1="4" x2="12" y2="20" stroke="currentColor" />
				<line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" />
			</>
		),
		layoutEvenH: (
			<>
				<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" />
				<line x1="2" y1="9.33" x2="22" y2="9.33" stroke="currentColor" />
				<line x1="2" y1="14.66" x2="22" y2="14.66" stroke="currentColor" />
			</>
		),
		layoutEvenV: (
			<>
				<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" />
				<line x1="8.66" y1="4" x2="8.66" y2="20" stroke="currentColor" />
				<line x1="15.33" y1="4" x2="15.33" y2="20" stroke="currentColor" />
			</>
		),
		layoutMainH: (
			<>
				<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" />
				<line x1="2" y1="13" x2="22" y2="13" stroke="currentColor" />
				<line x1="12" y1="13" x2="12" y2="20" stroke="currentColor" />
			</>
		),
		layoutMainV: (
			<>
				<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" />
				<line x1="13" y1="4" x2="13" y2="20" stroke="currentColor" />
				<line x1="13" y1="12" x2="22" y2="12" stroke="currentColor" />
			</>
		),
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
				<button className={tmuxBtnClass} onClick={handleTmuxAction("splitH")} title={t("tmux.splitHDesc")} aria-label={t("tmux.splitHDesc")}>
					<svg {...svgProps}>
						<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" />
						<line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" strokeDasharray="4 3" />
						<path d="M12 15 L12 19 M10 17 L14 17" className="text-success" stroke="currentColor" />
					</svg>
				</button>
				<button className={tmuxBtnClass} onClick={handleTmuxAction("splitV")} title={t("tmux.splitVDesc")} aria-label={t("tmux.splitVDesc")}>
					<svg {...svgProps}>
						<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" />
						<line x1="12" y1="4" x2="12" y2="20" stroke="currentColor" strokeDasharray="4 3" />
						<path d="M16 12 L20 12 M18 10 L18 14" className="text-success" stroke="currentColor" />
					</svg>
				</button>

				<div
					className="flex items-stretch rounded text-accent bg-accent/10 border border-accent/25 overflow-hidden"
					onMouseEnter={showLayout}
					onMouseLeave={hideLayout}
				>
					<button
						className="px-1.5 py-1 text-[0.625rem] font-medium transition-colors hover:bg-accent/20 flex items-center gap-1"
						onClick={cycleLayout}
						title={t("tmux.nextLayoutDesc")}
						aria-label={t("tmux.nextLayoutDesc")}
					>
						<svg {...svgProps}>{cycleIcon}</svg>
						<span>tmux layout</span>
					</button>
					<button
						ref={layoutTriggerRef}
						className="px-1 py-1 transition-colors hover:bg-accent/20 border-l border-accent/25 flex items-center justify-center"
						onClick={(event) => {
							event.stopPropagation();
							showLayout();
						}}
						title={t("tmux.chooseLayout")}
						aria-label={t("tmux.chooseLayout")}
						aria-haspopup="menu"
						aria-expanded={layoutOpen}
					>
						<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
							<path d="M6 9 L12 15 L18 9" stroke="currentColor" />
						</svg>
					</button>
				</div>

				<button className={tmuxBtnClass} onClick={handleTmuxAction("zoom")} title={t("tmux.zoomDesc")} aria-label={t("tmux.zoomDesc")}>
					<svg {...svgProps}>
						<rect x="4" y="6" width="16" height="12" rx="1" stroke="currentColor" />
						<path d="M2 5 L2 2 L5 2 M19 2 L22 2 L22 5 M22 19 L22 22 L19 22 M5 22 L2 22 L2 19" stroke="currentColor" />
						<path d="M2 2 L6 6 M22 2 L18 6 M22 22 L18 18 M2 22 L6 18" stroke="currentColor" />
					</svg>
				</button>
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
					<svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
						<path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11zM7.25 5a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7.25 7.25a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5z" />
					</svg>
				</button>

				<div className="w-px self-stretch bg-edge mx-0.5" aria-hidden="true" />

				<button
					className={`${tmuxBtnClass} text-danger hover:bg-danger/20 bg-danger/10 border-danger/25`}
					onClick={handleTmuxAction("killPane")}
					title={t("tmux.closePaneDesc")}
					aria-label={t("tmux.closePaneDesc")}
				>
					<svg {...svgProps}>
						<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" />
						<path d="M9 9 L15 15 M15 9 L9 15" stroke="currentColor" />
					</svg>
				</button>
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
						className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-elevated border border-transparent"
					>
						<span className="flex-shrink-0 text-fg-2">
							<svg {...svgProps}>{cycleIcon}</svg>
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
								className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors ${
									active ? "bg-accent/10 border border-accent/20" : "hover:bg-elevated border border-transparent"
								}`}
							>
								<span className={`flex-shrink-0 ${active ? "text-accent" : "text-fg-2"}`}>
									<svg {...svgProps}>{layoutIcons[action]}</svg>
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
