import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";

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
const WINDOW_POLL_MS = 3000;

interface WindowInfo {
	count: number;
	activeIndex: number;
	labels: string[];
}

function MobileWindowCarousel({
	taskId,
	onSwitch,
	children,
}: {
	taskId: string;
	onSwitch?: () => void;
	children: ReactNode;
}) {
	const t = useT();
	const [info, setInfo] = useState<WindowInfo>({ count: 0, activeIndex: 0, labels: [] });
	const [menuOpen, setMenuOpen] = useState(false);
	const busyRef = useRef(false);
	const menuRef = useRef<HTMLDivElement>(null);

	const navigate = useCallback(
		async (opts?: { step?: "next" | "prev"; index?: number }): Promise<WindowInfo | null> => {
			if (busyRef.current) return null;
			busyRef.current = true;
			try {
				const res = await api.request.tmuxWindowNavigate({ taskId, ...opts });
				setInfo(res);
				// Only when we actually moved windows — so the pane carousel re-reads +
				// re-zooms the new window's panes. A plain read (poll) must not retrigger.
				if (opts && (opts.step || typeof opts.index === "number")) onSwitch?.();
				return res;
			} catch {
				return null;
			} finally {
				busyRef.current = false;
			}
		},
		[taskId, onSwitch],
	);

	// Poll the window list read-only while mounted (windows open/close outside
	// React — ⌃B c, extra agents). Cheap: one list-windows per 3 s per open task.
	useEffect(() => {
		let cancelled = false;
		const tick = async () => {
			if (!cancelled) await navigate();
		};
		void tick();
		const id = setInterval(tick, WINDOW_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [taskId, navigate]);

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

	const multi = info.count > 1;
	const active = Math.max(0, Math.min(info.activeIndex, info.count - 1));
	const windowLabel = (i: number) => info.labels[i]?.trim() || t("windowPager.window", { index: String(i + 1) });

	const chevronBtn =
		"flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-3 hover:text-accent hover:bg-raised-hover transition-colors";

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			{/* Window switcher — ‹ prev · named dropdown · next › — sits above the pane
			    bar. A leading window glyph distinguishes it from the pane switcher. */}
			{multi && (
				<div
					className="relative z-20 flex-shrink-0 flex items-center gap-1 px-2 py-1 border-b border-edge/60 glass-header"
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
						<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F053}"}</span>
					</button>

					<div ref={menuRef} className="relative flex-1 min-w-0">
						<button
							type="button"
							onClick={() => setMenuOpen((o) => !o)}
							aria-haspopup="listbox"
							aria-expanded={menuOpen}
							aria-label={t("windowPager.switchWindow")}
							className="w-full h-8 flex items-center justify-center gap-1.5 rounded-lg px-2 text-fg-2 hover:bg-raised-hover transition-colors min-w-0"
						>
							<span className="text-[0.8rem] leading-none flex-shrink-0 text-fg-muted" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F05C2}"}</span>
							<span className="truncate text-xs font-medium">
								{active + 1}. {windowLabel(active)}
							</span>
							<span className="text-[0.5rem] leading-none flex-shrink-0 text-fg-muted" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F078}"}</span>
						</button>

						{menuOpen && (
							<div
								role="listbox"
								className="absolute left-0 right-0 top-full mt-1 z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-1 max-h-64 overflow-auto"
							>
								{Array.from({ length: info.count }, (_, i) => (
									<button
										key={i}
										type="button"
										role="option"
										aria-selected={i === active}
										onClick={() => {
											setMenuOpen(false);
											void navigate({ index: i });
										}}
										className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-xs transition-colors ${
											i === active ? "bg-accent/10 text-accent" : "text-fg-2 hover:bg-elevated"
										}`}
									>
										<span className="text-fg-muted tabular-nums w-4 flex-shrink-0">{i + 1}</span>
										<span className="truncate flex-1">{windowLabel(i)}</span>
										{i === active && (
											<span className="flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F00C}"}</span>
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
						<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F054}"}</span>
					</button>
				</div>
			)}

			<div className="flex-1 min-h-0 flex flex-col">{children}</div>
		</div>
	);
}

export default MobileWindowCarousel;
