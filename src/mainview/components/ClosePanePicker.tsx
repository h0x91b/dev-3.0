import { useCallback, useEffect, useState } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import { confirm } from "../confirm";
import { toast } from "../toast";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { CLOSE_PANE_PICKER_EVENT, type ClosePanePickerDetail } from "../close-pane-picker";

interface ClosePanePickerProps {
	taskId: string;
}

/** One clickable target region drawn over the terminal, in % of the window. */
interface HitBox {
	paneId: string;
	label: string;
	leftPct: number;
	topPct: number;
	widthPct: number;
	heightPct: number;
	/** Killing this pane would empty the session (needs a teardown confirm). */
	isLast: boolean;
}

/**
 * Two-step "Close Pane" picker overlay.
 *
 * Step 1 (elsewhere): the toolbar's red Close Pane button / native menu item
 * dispatches {@link CLOSE_PANE_PICKER_EVENT}. Step 2 (here): we read the tmux
 * layout, draw one hit-box per pane positioned by its real geometry (cells → %,
 * the same math the PaneMapSheet mini-map uses) directly over the ghostty-web
 * canvas. Hovering a pane paints it red; clicking it kills exactly that pane.
 * Esc — or a click on the surrounding scrim — cancels.
 *
 * Mounted inside TaskTerminal's `relative isolate` container so it clips to the
 * terminal and its z-index stays local (above PaneZoomBadge's z-20).
 *
 * Zoom-aware: a zoomed window shows only its active pane on screen, so we draw a
 * single full-cover hit-box for that pane instead of the hidden split geometry.
 */
export default function ClosePanePicker({ taskId }: ClosePanePickerProps) {
	const t = useT();
	const [boxes, setBoxes] = useState<HitBox[] | null>(null);
	const [busy, setBusy] = useState(false);

	const active = boxes !== null;

	const cancel = useCallback(() => {
		setBoxes(null);
		setBusy(false);
	}, []);

	useEscapeKey(cancel, { enabled: active });

	const begin = useCallback(async () => {
		let layout;
		try {
			layout = await api.request.tmuxLayout({ taskId });
		} catch {
			toast.error(t("tmux.pickPaneError"));
			return;
		}
		const activeWindow = layout.exists ? layout.windows.find((w) => w.active) ?? layout.windows[0] : undefined;
		const winPanes = activeWindow
			? layout.panes.filter((p) => p.windowIndex === activeWindow.index)
			: [];
		if (!activeWindow || winPanes.length === 0) {
			toast.error(t("tmux.pickPaneError"));
			return;
		}

		const isLast = winPanes.length === 1;
		const paneLabel = (command: string, i: number) =>
			command.trim() || t("panePager.pane", { index: String(i + 1) });

		// Character-cell extent of the window's PANE AREA (excludes the tmux status bar).
		const winW = Math.max(1, ...winPanes.map((p) => p.left + p.width));
		const winH = Math.max(1, ...winPanes.map((p) => p.top + p.height));
		// The ghostty canvas the overlay covers renders the WHOLE terminal — including
		// the tmux status bar, which the pane geometry above excludes. So map vertical
		// positions over the full canvas height (pane rows + status rows), and shift
		// down by the status bar when it sits on top. Without this every row lands a
		// little too low and the bottom pane overshoots into the status line. Columns
		// have no such reservation, so horizontal stays mapped over winW.
		const statusLines = Math.max(0, layout.statusLines ?? 0);
		const statusTop = layout.statusAtTop ? statusLines : 0;
		const canvasH = winH + statusLines;

		// Zoomed: only the active pane is visible — one hit-box covering the pane area.
		if (activeWindow.zoomed) {
			const target = winPanes.find((p) => p.active) ?? winPanes[0];
			setBoxes([
				{
					paneId: target.paneId,
					label: paneLabel(target.command, winPanes.indexOf(target)),
					leftPct: 0,
					topPct: (statusTop / canvasH) * 100,
					widthPct: 100,
					heightPct: (winH / canvasH) * 100,
					isLast,
				},
			]);
			setBusy(false);
			return;
		}

		// tmux separates panes with a 1-cell divider, so raw pane rects leave a gap
		// between neighbours. Grow each rect by half a cell toward its neighbours
		// (clamped to the window) so adjacent boxes MEET at the divider midpoint and
		// tile with no geometry gap — the only visible gutter is then the uniform CSS
		// inset below, sitting right on the divider. Without this the divider gap +
		// the per-box inset stack into big, uneven gaps between panes.
		const GUTTER = 0.5;
		setBoxes(
			winPanes.map((p, i) => {
				const left = Math.max(0, p.left - GUTTER);
				const top = Math.max(0, p.top - GUTTER);
				const right = Math.min(winW, p.left + p.width + GUTTER);
				const bottom = Math.min(winH, p.top + p.height + GUTTER);
				return {
					paneId: p.paneId,
					label: paneLabel(p.command, i),
					leftPct: (left / winW) * 100,
					topPct: ((statusTop + top) / canvasH) * 100,
					widthPct: ((right - left) / winW) * 100,
					heightPct: ((bottom - top) / canvasH) * 100,
					isLast,
				};
			}),
		);
		setBusy(false);
	}, [taskId, t]);

	// Listen for the toolbar/menu "start picker" request (scoped by taskId).
	useEffect(() => {
		function onStart(e: Event) {
			const detail = (e as CustomEvent<ClosePanePickerDetail>).detail;
			if (detail?.taskId !== taskId) return;
			void begin();
		}
		window.addEventListener(CLOSE_PANE_PICKER_EVENT, onStart);
		return () => window.removeEventListener(CLOSE_PANE_PICKER_EVENT, onStart);
	}, [taskId, begin]);

	async function commit(box: HitBox) {
		if (busy) return;
		if (box.isLast) {
			// The only pane — closing it tears down the whole session. Confirm first,
			// then force past the backend's last-pane guard.
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
			if (!confirmed) {
				cancel();
				return;
			}
			setBusy(true);
			try {
				await api.request.tmuxKillPane({ taskId, paneId: box.paneId, force: true });
			} catch {
				toast.error(t("tmux.pickPaneError"));
			}
			cancel();
			return;
		}
		setBusy(true);
		try {
			await api.request.tmuxKillPane({ taskId, paneId: box.paneId });
		} catch {
			toast.error(t("tmux.pickPaneError"));
		}
		cancel();
	}

	if (!boxes) return null;

	return (
		<div
			className="absolute inset-0 z-30 cursor-pointer bg-black/25"
			role="dialog"
			aria-modal="true"
			aria-label={t("tmux.pickPaneHint")}
			onClick={cancel}
		>
			{/* Mode hint — solid pill so it stays readable over any terminal output. */}
			<div className="pointer-events-none absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-edge-active bg-overlay/95 px-4 py-2 text-sm text-fg shadow-2xl shadow-black/50">
				<svg className="h-4 w-4 flex-shrink-0 text-danger" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<circle cx="12" cy="12" r="9" stroke="currentColor" />
					<path d="M9 9 L15 15 M15 9 L9 15" stroke="currentColor" />
				</svg>
				<span className="font-semibold">{t("tmux.pickPaneHint")}</span>
				<span className="font-normal text-fg-3">{t("tmux.pickPaneCancel")}</span>
			</div>

			{boxes.map((box) => (
				<button
					key={box.paneId}
					type="button"
					disabled={busy}
					aria-label={t("tmux.pickPaneAria", { label: box.label })}
					onClick={(e) => {
						e.stopPropagation();
						void commit(box);
					}}
					className="group absolute cursor-pointer focus:outline-none"
					style={{
						left: `${box.leftPct}%`,
						top: `${box.topPct}%`,
						width: `${box.widthPct}%`,
						height: `${box.heightPct}%`,
					}}
				>
					{/* Small uniform gutter. The boxes already tile edge-to-edge (see the
					    GUTTER expansion in begin()), so this 6px inset is the ONLY gap
					    between panes and it lands on the tmux divider — even and tidy,
					    not the big uneven holes the raw geometry produced. */}
					{/* Fill (only on hover/focus). */}
					<span className="pointer-events-none absolute inset-[6px] rounded-sm bg-danger/0 transition-colors duration-200 group-hover:bg-danger/15 group-focus-visible:bg-danger/15" />
					{/* Marching-ants marquee: neutral accent while idle, danger on hover. */}
					<span className="dev3-marching-ants pointer-events-none absolute inset-[6px] text-accent/70 transition-colors duration-200 group-hover:text-danger group-focus-visible:text-danger" />
					{/* Close chip — appears only for the armed pane. */}
					<span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
						<span className="inline-flex max-w-[85%] items-center gap-1.5 rounded-full bg-danger px-2.5 py-1 text-xs font-semibold text-white shadow-lg shadow-black/40">
							<svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" />
							</svg>
							<span className="truncate">
								{t("tmux.pickPaneClose")}
								{box.label ? ` · ${box.label}` : ""}
							</span>
						</span>
					</span>
				</button>
			))}
		</div>
	);
}
