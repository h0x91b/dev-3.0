import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import { ZoomPaneIcon } from "./TmuxIcons";
import Tooltip from "./Tooltip";

/**
 * Full-viewport (non-narrow) tmux zoom indicator.
 *
 * tmux's zoom flag is shared, per-window state and easy to miss: a pane zoomed
 * on a phone (the one-pane carousel view) leaks to the desktop split, and `⌃B z`
 * leaves no obvious way back. This badge surfaces the zoomed state and offers a
 * one-tap un-zoom.
 *
 * It only ever READS zoom (a read-only `tmuxPaneNavigate` poll) — it never
 * mutates the shared view unless the user taps it. We deliberately do NOT
 * auto-un-zoom on entry: that would fight a deliberate desktop `⌃B z` and break
 * a phone client attached to the same session (see decision 091).
 */
const ZOOM_POLL_MS = 3000;

function PaneZoomBadge({ taskId }: { taskId: string }) {
	const t = useT();
	const [zoomed, setZoomed] = useState(false);
	const [multi, setMulti] = useState(false);
	const busyRef = useRef(false);

	const read = useCallback(
		async (zoom?: boolean) => {
			if (busyRef.current) return;
			busyRef.current = true;
			try {
				const res = await api.request.tmuxPaneNavigate(zoom === undefined ? { taskId } : { taskId, zoom });
				setZoomed(res.zoomed);
				setMulti(res.count > 1);
			} catch {
				// Transient (session not ready / restarting) — the next poll retries.
			} finally {
				busyRef.current = false;
			}
		},
		[taskId],
	);

	useEffect(() => {
		let cancelled = false;
		const tick = () => {
			if (!cancelled) void read();
		};
		tick();
		const id = setInterval(tick, ZOOM_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [read]);

	// A single-pane window is always "full" — zoom is meaningless, show nothing.
	if (!zoomed || !multi) return null;

	return (
		<Tooltip content={t("paneZoom.restore")} placement="bottom">
			<button
				type="button"
				onClick={() => read(false)}
				aria-label={t("paneZoom.restore")}
				className="tmux-anim absolute top-2 right-2 z-20 flex items-center gap-1.5 rounded-full border border-hint-border bg-hint px-3 py-1 text-xs font-bold uppercase tracking-wide text-hint-fg shadow-lg shadow-black/40 transition-[filter] hover:brightness-110"
			>
				{/* Same custom zoom glyph as the tmux zoom control (TaskTmuxControls). */}
				<ZoomPaneIcon className="h-3.5 w-3.5" />
				{t("paneZoom.badge")}
			</button>
		</Tooltip>
	);
}

export default PaneZoomBadge;
