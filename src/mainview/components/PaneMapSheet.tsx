import { useEffect, useState } from "react";
import type { TmuxLayout, TmuxPaneInfo, TmuxWindowInfo } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import BottomSheet from "./BottomSheet";

interface PaneMapSheetProps {
	taskId: string;
	open: boolean;
	onClose: () => void;
	/** Jump to a pane by its tmux pane id (e.g. "%5") and zoom it. */
	onJump: (paneId: string) => void | Promise<void>;
}

/**
 * Narrow-viewport "zoom-out" overview: a spatial mini-map of the active tmux
 * window's panes, positioned by their real geometry (pane_left/top/width/height)
 * — the same picture `dev3 ui state` prints as ASCII boxes. Tap a box to jump to
 * (and zoom) that pane. When the session has more than one window, a read-only
 * window list is shown below as the foundation for a future windows switcher.
 */
export default function PaneMapSheet({ taskId, open, onClose, onJump }: PaneMapSheetProps) {
	const t = useT();
	const [layout, setLayout] = useState<TmuxLayout | null>(null);
	const [loading, setLoading] = useState(false);

	// Re-fetch the layout each time the sheet opens (panes/windows change outside
	// React — extra agents, dev server, manual splits).
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		(async () => {
			try {
				const res = await api.request.tmuxLayout({ taskId });
				if (!cancelled) setLayout(res);
			} catch {
				if (!cancelled) setLayout(null);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, taskId]);

	const activeWindow: TmuxWindowInfo | undefined = layout?.windows.find((w) => w.active) ?? layout?.windows[0];
	const panes: TmuxPaneInfo[] = activeWindow
		? (layout?.panes ?? []).filter((p) => p.windowIndex === activeWindow.index)
		: [];
	// Window extent in character cells. `... || 1` guards an empty/degenerate read.
	const winW = Math.max(1, ...panes.map((p) => p.left + p.width));
	const winH = Math.max(1, ...panes.map((p) => p.top + p.height));
	// Terminal cells are ~2× taller than wide; halving the height contribution
	// makes the map's shape match what's on screen. Clamp so a tall/wide split
	// never produces an extreme box on a phone.
	const aspect = Math.min(2.4, Math.max(1.1, winW / (winH * 2)));

	const paneLabel = (p: TmuxPaneInfo, i: number) => p.command?.trim() || t("panePager.pane", { index: String(i + 1) });

	async function handleJump(paneId: string) {
		onClose();
		await onJump(paneId);
	}

	return (
		<BottomSheet open={open} onClose={onClose} title={t("paneMap.title")} testId="pane-map-sheet">
			{loading && !layout ? (
				<div className="py-8 text-center text-fg-3 text-sm">{t("paneMap.loading")}</div>
			) : panes.length === 0 ? (
				<div className="py-8 text-center text-fg-3 text-sm">{t("paneMap.empty")}</div>
			) : (
				<>
					<p className="mb-2 text-fg-muted text-xs">{t("paneMap.hint")}</p>
					<div
						className="relative w-full overflow-hidden rounded-xl border border-edge bg-base"
						style={{ aspectRatio: String(aspect), maxHeight: "42vh" }}
						role="group"
						aria-label={t("paneMap.title")}
					>
						{panes.map((p, i) => {
							const label = paneLabel(p, i);
							return (
								<button
									key={p.paneId}
									type="button"
									onClick={() => handleJump(p.paneId)}
									aria-label={t("paneMap.goTo", { label })}
									aria-current={p.active ? "true" : undefined}
									className={`absolute flex flex-col items-start justify-start gap-0.5 overflow-hidden rounded-md border p-1.5 text-left transition-colors ${
										p.active
											? "border-accent bg-accent/15 text-accent"
											: "border-edge-active bg-elevated text-fg-2 hover:border-accent/50 hover:bg-elevated-hover"
									}`}
									style={{
										left: `${(p.left / winW) * 100}%`,
										top: `${(p.top / winH) * 100}%`,
										width: `${(p.width / winW) * 100}%`,
										height: `${(p.height / winH) * 100}%`,
									}}
								>
									<span className="max-w-full truncate text-[0.7rem] font-medium leading-tight">{label}</span>
									{p.active && <span className="text-[0.6rem] leading-none opacity-80">{t("paneMap.current")}</span>}
								</button>
							);
						})}
					</div>

					{layout && layout.windows.length > 1 && (
						<div className="mt-3 border-t border-edge/60 pt-3">
							<p className="mb-1.5 text-fg-muted text-xs">{t("paneMap.windows")}</p>
							<ul className="space-y-1">
								{layout.windows.map((w) => (
									<li
										key={w.index}
										className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ${
											w.active ? "bg-accent/10 text-accent" : "text-fg-3"
										}`}
									>
										<span className="w-4 flex-shrink-0 tabular-nums text-fg-muted">{w.index}</span>
										<span className="flex-1 truncate">{w.name || t("paneMap.untitledWindow")}</span>
										<span className="flex-shrink-0 text-fg-muted">{t.plural("paneMap.paneCount", w.panes)}</span>
									</li>
								))}
							</ul>
						</div>
					)}
				</>
			)}
		</BottomSheet>
	);
}
