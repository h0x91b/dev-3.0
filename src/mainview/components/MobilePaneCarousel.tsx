import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import { confirm } from "../confirm";
import BottomSheet from "./BottomSheet";
import PaneMapSheet from "./PaneMapSheet";

type ManageAction = "splitH" | "splitV" | "newWindow" | "killPane";

/**
 * Narrow-viewport terminal pane switcher. The tmux window is kept zoomed to one
 * pane (so only one shows at a time). A top bar — ‹ prev · a named-pane dropdown ·
 * next › — switches panes and re-zooms the target; Arrow keys, a horizontal swipe
 * over the terminal, and a horizontal trackpad scroll do the same.
 *
 * The buttons/dropdown are the reliable path. The swipe is best-effort: the
 * ghostty canvas turns touch into mouse events (selection / SGR mouse for
 * vim/htop/less), so we arbitrate by axis in the CAPTURE phase — a clearly
 * horizontal drag is ours (preventDefault + stopPropagation so the canvas never
 * sees the move, and we collapse any nascent selection at the START coords),
 * while a vertical drag or a tap falls through to the terminal untouched.
 */
const PANE_POLL_MS = 3000;
const SWIPE_DECIDE_PX = 10; // movement before we lock the gesture axis
const SWIPE_COMMIT_PX = 50; // horizontal distance that triggers a pane change
const SWIPE_FOLLOW_MAX = 80; // clamp for the live drag-follow translate
const WHEEL_COMMIT_PX = 90; // accumulated horizontal trackpad delta per switch

interface PaneInfo {
	count: number;
	activeIndex: number;
	zoomed: boolean;
	labels: string[];
}

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function MobilePaneCarousel({ taskId, refreshKey, children }: { taskId: string; refreshKey?: number; children: ReactNode }) {
	const t = useT();
	const [info, setInfo] = useState<PaneInfo>({ count: 0, activeIndex: 0, zoomed: false, labels: [] });
	const [dragDx, setDragDx] = useState(0);
	const [menuOpen, setMenuOpen] = useState(false);
	const [mapOpen, setMapOpen] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	// Auto-zoom only the FIRST time a multi-pane session is seen, so we never
	// fight a user who deliberately un-zoomed to inspect the split.
	const zoomedOnEntryRef = useRef(false);
	const busyRef = useRef(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	// Keep the live count available to the touch/wheel handlers without re-binding.
	const countRef = useRef(0);
	countRef.current = info.count;

	const navigate = useCallback(
		async (opts?: { step?: "next" | "prev"; index?: number; paneId?: string; zoom?: boolean }): Promise<PaneInfo | null> => {
			if (busyRef.current) return null;
			busyRef.current = true;
			try {
				const res = await api.request.tmuxPaneNavigate({ taskId, ...opts });
				setInfo(res);
				return res;
			} catch {
				return null;
			} finally {
				busyRef.current = false;
			}
		},
		[taskId],
	);

	// Create / close panes and windows from the sheet. The ⌃B prefix is the only
	// other path and is impractical on a phone, so these touch controls are the
	// canonical mobile way to split or open a tmux window. After the action we
	// refresh+zoom immediately (don't wait up to PANE_POLL_MS for the poll) so the
	// freshly-created split / new window's shell shows at once.
	const runManageAction = useCallback(
		async (action: ManageAction) => {
			setSheetOpen(false);
			if (action === "killPane") {
				// Closing the only pane in the session tears down tmux (and the agent).
				// Count session-wide (matches the backend's last-pane guard) and confirm.
				let count = 0;
				try {
					count = (await api.request.tmuxPaneCount({ taskId })).count;
				} catch {
					count = 0;
				}
				if (count <= 1) {
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
					await api.request.tmuxAction({ taskId, action, force: true }).catch(() => {});
				} else {
					await api.request.tmuxAction({ taskId, action }).catch(() => {});
				}
			} else {
				await api.request.tmuxAction({ taskId, action }).catch(() => {});
			}
			await navigate({ zoom: true });
		},
		[taskId, navigate, t],
	);

	// Poll the layout while mounted (panes appear/vanish outside React — dev
	// server, extra agents). Auto-zoom once on the first multi-pane sighting.
	// `refreshKey` changes when the window switcher moves to another tmux window:
	// treat it like a fresh entry so we immediately re-read AND re-zoom the new
	// window's panes (its zoom state is independent of the previous window's).
	useEffect(() => {
		let cancelled = false;
		zoomedOnEntryRef.current = false;
		const tick = async () => {
			if (cancelled) return;
			const wantZoom = !zoomedOnEntryRef.current;
			const res = await navigate(wantZoom ? { zoom: true } : undefined);
			if (res && res.count > 1) zoomedOnEntryRef.current = true;
		};
		void tick();
		const id = setInterval(tick, PANE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [taskId, navigate, refreshKey]);

	// Horizontal swipe (axis-arbitrated) + horizontal trackpad scroll.
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const reduce = prefersReducedMotion();
		let startX = 0;
		let startY = 0;
		let dx = 0;
		let axis: "h" | "v" | null = null;
		let wheelAccum = 0;

		function onStart(e: TouchEvent) {
			if (e.touches.length !== 1) {
				axis = "v"; // multi-touch (pinch/zoom) is never a pane swipe
				return;
			}
			startX = e.touches[0].clientX;
			startY = e.touches[0].clientY;
			dx = 0;
			axis = null;
		}

		function onMove(e: TouchEvent) {
			if (axis === "v" || e.touches.length !== 1) return;
			dx = e.touches[0].clientX - startX;
			const dy = e.touches[0].clientY - startY;
			if (axis === null) {
				if (Math.abs(dx) > SWIPE_DECIDE_PX && Math.abs(dx) > Math.abs(dy) * 1.4) {
					axis = "h";
					// The initial touch already fired touchstart→mousedown on the canvas.
					// Collapse any nascent selection by ending the drag AT THE START point
					// (a mouseup elsewhere — e.g. 0,0 — would select to there) plus a click.
					const canvas = el!.querySelector("canvas");
					if (canvas) {
						const at = { bubbles: true, clientX: startX, clientY: startY } as MouseEventInit;
						canvas.dispatchEvent(new MouseEvent("mouseup", at));
						canvas.dispatchEvent(new MouseEvent("mousedown", at));
						canvas.dispatchEvent(new MouseEvent("mouseup", at));
					}
				} else if (Math.abs(dy) > SWIPE_DECIDE_PX) {
					axis = "v";
					return;
				} else {
					return;
				}
			}
			if (axis === "h") {
				// Ours: stop the canvas from scrolling/selecting under the swipe.
				e.preventDefault();
				e.stopPropagation();
				if (!reduce) {
					setDragDx(Math.max(-SWIPE_FOLLOW_MAX, Math.min(SWIPE_FOLLOW_MAX, dx / 2)));
				}
			}
		}

		function onEnd() {
			if (axis === "h" && Math.abs(dx) > SWIPE_COMMIT_PX && countRef.current > 1) {
				// Swipe left (dx<0) → next pane; swipe right → previous.
				void navigate({ step: dx < 0 ? "next" : "prev", zoom: true });
			}
			axis = null;
			dx = 0;
			setDragDx(0);
		}

		// Two-finger horizontal trackpad scroll (macOS / narrow desktop window).
		function onWheel(e: WheelEvent) {
			if (countRef.current <= 1) return;
			if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical → leave for scrollback
			e.preventDefault();
			wheelAccum += e.deltaX;
			if (Math.abs(wheelAccum) >= WHEEL_COMMIT_PX) {
				const step = wheelAccum > 0 ? "next" : "prev";
				wheelAccum = 0;
				void navigate({ step, zoom: true });
			}
		}

		el.addEventListener("touchstart", onStart, { capture: true, passive: true });
		el.addEventListener("touchmove", onMove, { capture: true, passive: false });
		el.addEventListener("touchend", onEnd, { capture: true });
		el.addEventListener("touchcancel", onEnd, { capture: true });
		el.addEventListener("wheel", onWheel, { capture: true, passive: false });
		return () => {
			el.removeEventListener("touchstart", onStart, { capture: true });
			el.removeEventListener("touchmove", onMove, { capture: true });
			el.removeEventListener("touchend", onEnd, { capture: true });
			el.removeEventListener("touchcancel", onEnd, { capture: true });
			el.removeEventListener("wheel", onWheel, { capture: true });
		};
	}, [navigate]);

	// Close the pane dropdown on outside click / Escape.
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

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			void navigate({ step: "prev", zoom: true });
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			void navigate({ step: "next", zoom: true });
		}
	}

	const multi = info.count > 1;
	const active = Math.max(0, Math.min(info.activeIndex, info.count - 1));
	const paneLabel = (i: number) => info.labels[i]?.trim() || t("panePager.pane", { index: String(i + 1) });

	const chevronBtn =
		"flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-3 hover:text-accent hover:bg-raised-hover transition-colors";

	// Show the top bar whenever the session has at least one pane — the manage
	// button (which opens the create/close sheet) must be reachable even on a
	// single-pane window, since that is the common starting state on a phone.
	const showBar = info.count >= 1;

	const svgProps = {
		className: "w-5 h-5 flex-shrink-0",
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.5,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	};
	const manageActions: { action: ManageAction; labelKey: Parameters<typeof t>[0]; icon: ReactNode; danger?: boolean }[] = [
		{
			action: "splitH",
			labelKey: "tmux.splitHDesc",
			icon: (
				<svg {...svgProps}>
					<rect x="2" y="4" width="20" height="16" rx="2" />
					<line x1="2" y1="12" x2="22" y2="12" strokeDasharray="4 3" />
					<path d="M12 15 L12 19 M10 17 L14 17" />
				</svg>
			),
		},
		{
			action: "splitV",
			labelKey: "tmux.splitVDesc",
			icon: (
				<svg {...svgProps}>
					<rect x="2" y="4" width="20" height="16" rx="2" />
					<line x1="12" y1="4" x2="12" y2="20" strokeDasharray="4 3" />
					<path d="M16 12 L20 12 M18 10 L18 14" />
				</svg>
			),
		},
		{
			action: "newWindow",
			labelKey: "cheatSheet.newWindow",
			icon: (
				<svg {...svgProps}>
					<rect x="2" y="4" width="20" height="16" rx="2" />
					<line x1="2" y1="9" x2="22" y2="9" />
					<path d="M12 12.5 L12 17.5 M9.5 15 L14.5 15" />
				</svg>
			),
		},
	];

	return (
		<div
			className="flex-1 min-h-0 flex flex-col isolate"
			role="group"
			aria-roledescription={t("panePager.role")}
			tabIndex={multi ? 0 : -1}
			onKeyDown={handleKeyDown}
		>
			{/* Top bar — pane switcher (‹ prev · named dropdown · next ›) when there
			    are multiple panes, else just the current pane name, plus a "Panes &
			    windows" button that opens the create/close sheet. Never overlaps the
			    terminal and sits at the top, off the on-screen keyboard. */}
			{showBar && (
				<div className="relative z-10 flex-shrink-0 flex items-center gap-1 px-2 py-1 border-b border-edge/60 glass-header">
					{multi ? (
					<>
					<button
						type="button"
						onClick={() => setMapOpen(true)}
						aria-label={t("paneMap.open")}
						title={t("paneMap.open")}
						className={chevronBtn}
					>
						<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0570}"}</span>
					</button>
					<button
						type="button"
						onClick={() => navigate({ step: "prev", zoom: true })}
						aria-label={t("panePager.prev")}
						title={t("panePager.prev")}
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
							aria-label={t("panePager.switchPane")}
							className="w-full h-8 flex items-center justify-center gap-1.5 rounded-lg px-2 text-fg-2 hover:bg-raised-hover transition-colors min-w-0"
						>
							<span className="truncate text-xs font-medium">
								{active + 1}. {paneLabel(active)}
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
											void navigate({ index: i, zoom: true });
										}}
										className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-xs transition-colors ${
											i === active ? "bg-accent/10 text-accent" : "text-fg-2 hover:bg-elevated"
										}`}
									>
										<span className="text-fg-muted tabular-nums w-4 flex-shrink-0">{i + 1}</span>
										<span className="truncate flex-1">{paneLabel(i)}</span>
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
						onClick={() => navigate({ step: "next", zoom: true })}
						aria-label={t("panePager.next")}
						title={t("panePager.next")}
						className={chevronBtn}
					>
						<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F054}"}</span>
					</button>
					</>
					) : (
						<span className="flex-1 min-w-0 truncate px-1 text-xs font-medium text-fg-muted">
							{paneLabel(0)}
						</span>
					)}

					<button
						type="button"
						onClick={() => setSheetOpen(true)}
						aria-label={t("panePager.manage")}
						title={t("panePager.manage")}
						className={chevronBtn}
					>
						<svg className="w-[1.125rem] h-[1.125rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
							<rect x="3" y="4" width="18" height="16" rx="2" />
							<line x1="12" y1="4" x2="12" y2="20" />
						</svg>
					</button>
				</div>
			)}

			<div ref={wrapRef} data-testid="pane-carousel-surface" className="relative z-0 flex-1 min-h-0 overflow-hidden">
				<div
					className="h-full w-full"
					style={{
						transform: dragDx ? `translateX(${dragDx}px)` : undefined,
						transition: dragDx ? "none" : "transform 150ms ease",
					}}
				>
					{children}
				</div>
			</div>

			<PaneMapSheet
				taskId={taskId}
				open={mapOpen}
				onClose={() => setMapOpen(false)}
				onJump={(paneId) => {
					void navigate({ paneId, zoom: true });
				}}
			/>

			<BottomSheet
				open={sheetOpen}
				onClose={() => setSheetOpen(false)}
				title={t("panePager.manage")}
				testId="pane-manage-sheet"
			>
				<div className="flex flex-col gap-1">
					<div className="px-1 pb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-muted">
						{t("panePager.create")}
					</div>
					{manageActions.map(({ action, labelKey, icon }) => (
						<button
							key={action}
							type="button"
							onClick={() => void runManageAction(action)}
							className="w-full flex items-center gap-3 min-h-[44px] px-3 rounded-xl text-left text-sm text-fg-2 hover:bg-elevated transition-colors"
						>
							<span className="text-fg-3">{icon}</span>
							<span className="flex-1">{t(labelKey)}</span>
						</button>
					))}

					<div className="my-1 border-t border-edge/60" />

					<button
						type="button"
						onClick={() => void runManageAction("killPane")}
						className="w-full flex items-center gap-3 min-h-[44px] px-3 rounded-xl text-left text-sm text-danger hover:bg-danger/10 transition-colors"
					>
						<span>
							<svg {...svgProps}>
								<rect x="2" y="4" width="20" height="16" rx="2" />
								<path d="M9 9 L15 15 M15 9 L9 15" />
							</svg>
						</span>
						<span className="flex-1">{t("tmux.closePaneDesc")}</span>
					</button>

					<p className="mt-2 px-1 text-[0.6875rem] leading-snug text-fg-muted">
						{t("panePager.windowHint")}
					</p>
				</div>
			</BottomSheet>
		</div>
	);
}

export default MobilePaneCarousel;
