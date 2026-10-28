import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { useTmuxWindows } from "../hooks/useTmuxWindows";
import { windowName } from "./TerminalWindowNav";

/**
 * Narrow-viewport tmux WINDOW switcher — the sibling of {@link MobilePaneCarousel}.
 * A tmux session can hold several windows (separate workspaces); on a phone over
 * `dev3 remote` they were invisible and unreachable. This renders a slim top bar
 * — ‹ prev · a named-window dropdown · next › — that sits ABOVE the pane bar
 * (window = outer workspace, pane = inner split). It switches windows via
 * `select-window`; the attached terminal redraws the new window instantly, and
 * `onSwitch` lets the parent re-read the pane carousel for the new window.
 *
 * Unlike the pane carousel there is NO swipe: the terminal's horizontal swipe is
 * already claimed by the pane carousel, so windows are buttons + dropdown only
 * (which are inherently keyboard-reachable; Arrow keys work while the bar is
 * focused). Single-window sessions render no chrome at all.
 */
function MobileWindowCarousel({
	taskId,
	taskTitle,
	onSwitch,
	children,
}: {
	taskId: string;
	/** Names the agent's home window, matching the tmux bar. */
	taskTitle?: string;
	onSwitch?: () => void;
	children: ReactNode;
}) {
	const t = useT();
	const { windows, active, home, navigate: request } = useTmuxWindows(taskId);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	// Only an actual move tells the pane carousel to re-read the new window's panes.
	const navigate = useCallback(
		async (opts: { step?: "next" | "prev"; windowId?: string }) => {
			await request(opts);
			onSwitch?.();
		},
		[request, onSwitch],
	);

	// Close the window dropdown on outside click / Escape.
	useEffect(() => {
		if (!menuOpen) return;
		function onDown(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setMenuOpen(false);
		}
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [menuOpen]);

	// Arrow keys move between windows ONLY while focus is inside this bar — the
	// pane carousel owns Arrow keys when ITS group is focused, so they never clash.
	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			void navigate({ step: "prev" });
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			void navigate({ step: "next" });
		}
	}

	const multi = windows.length > 1;
	const showHome = !!home && !home.active;

	// Touch-sized, in lockstep with the pane bar right below it.
	const chevronBtn =
		"flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-fg-3 hover:text-accent hover:bg-raised-hover transition-colors";

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			{/* Window switcher — ‹ prev · named dropdown · next › — sits above the pane
			    bar. A leading window glyph distinguishes it from the pane switcher. */}
			{multi && (
				<div
					className="relative z-20 flex-shrink-0 flex items-center gap-1 px-3 py-2 min-h-[3.25rem] border-b border-edge/60 glass-header"
					role="group"
					aria-roledescription={t("windowPager.role")}
					tabIndex={0}
					onKeyDown={handleKeyDown}
				>
					<button
						type="button"
						onClick={() => navigate({ step: "prev" })}
						aria-label={t("windowPager.prev")}
						title={t("windowPager.prev")}
						className={chevronBtn}
					>
						<span className="text-base leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F053}"}</span>
					</button>

					{showHome && home && (
						<button
							type="button"
							onClick={() => navigate({ windowId: home.windowId })}
							aria-label={t("windowPager.home")}
							title={t("windowPager.home")}
							className={chevronBtn}
						>
							<span aria-hidden="true" className="text-base leading-none">✦</span>
						</button>
					)}

					<div ref={menuRef} className="relative flex-1 min-w-0">
						<button
							type="button"
							onClick={() => setMenuOpen((o) => !o)}
							aria-haspopup="listbox"
							aria-expanded={menuOpen}
							aria-label={active ? `${t("windowPager.switchWindow")}: ${active.index}. ${windowName(active, t, taskTitle)}` : t("windowPager.switchWindow")}
							className="w-full h-11 flex items-center justify-center gap-1.5 rounded-lg px-2 text-fg-2 hover:bg-raised-hover transition-colors min-w-0"
						>
							<span aria-hidden="true" className="text-base-lg leading-none flex-shrink-0 text-fg-muted" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{active?.home ? "✦" : "\u{F05C2}"}</span>
							<span className="truncate text-sm font-medium">
								{active ? `${active.index}. ${windowName(active, t, taskTitle)}` : ""}
							</span>
							<span aria-hidden="true" className="text-micro leading-none flex-shrink-0 text-fg-muted" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F078}"}</span>
						</button>

						{menuOpen && (
							<div
								role="listbox"
								aria-label={t("windowPager.role")}
								className="absolute left-0 right-0 top-full mt-1 z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-1 max-h-64 overflow-auto"
							>
								{windows.map((w) => (
									<button
										key={w.windowId}
										type="button"
										role="option"
										aria-selected={w.active}
										onClick={() => {
											setMenuOpen(false);
											void navigate({ windowId: w.windowId });
										}}
										className={`w-full flex items-center gap-2 px-2.5 min-h-[2.75rem] rounded-lg text-left text-sm transition-colors ${
											w.active ? "bg-accent/10 text-accent" : "text-fg-2 hover:bg-overlay-hover"
										}`}
									>
										<span aria-hidden="true" className="text-fg-muted tabular-nums w-4 flex-shrink-0">{w.home ? "✦" : w.index}</span>
										<span className="truncate flex-1">{windowName(w, t, taskTitle)}{w.home ? ` · ${t("windowNav.home")}` : ""}</span>
										{w.active && (
											<span aria-hidden="true" className="flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F00C}"}</span>
										)}
									</button>
								))}
							</div>
						)}
					</div>

					<button
						type="button"
						onClick={() => navigate({ step: "next" })}
						aria-label={t("windowPager.next")}
						title={t("windowPager.next")}
						className={chevronBtn}
					>
						<span className="text-base leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F054}"}</span>
					</button>
				</div>
			)}

			<div className="flex-1 min-h-0 flex flex-col">{children}</div>
		</div>
	);
}

export default MobileWindowCarousel;
