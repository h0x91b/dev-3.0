import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import PaneMapSheet from "./PaneMapSheet";

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

function MobilePaneCarousel({ taskId, children }: { taskId: string; children: ReactNode }) {
	const t = useT();
	const [info, setInfo] = useState<PaneInfo>({ count: 0, activeIndex: 0, zoomed: false, labels: [] });
	const [dragDx, setDragDx] = useState(0);
	const [menuOpen, setMenuOpen] = useState(false);
	const [mapOpen, setMapOpen] = useState(false);
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

	// Poll the layout while mounted (panes appear/vanish outside React — dev
	// server, extra agents). Auto-zoom once on the first multi-pane sighting.
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
	}, [taskId, navigate]);

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

	return (
		<div
			className="flex-1 min-h-0 flex flex-col isolate"
			role="group"
			aria-roledescription={t("panePager.role")}
			tabIndex={multi ? 0 : -1}
			onKeyDown={handleKeyDown}
		>
			{/* Pane switcher — ‹ prev · named dropdown · next › — never overlaps the
			    terminal and sits at the top, off the on-screen keyboard. */}
			{multi && (
				<div className="relative z-10 flex-shrink-0 flex items-center gap-1 px-2 py-1 border-b border-edge/60 glass-header">
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
		</div>
	);
}

export default MobilePaneCarousel;
