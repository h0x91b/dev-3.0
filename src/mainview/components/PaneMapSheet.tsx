import { useEffect, useState } from "react";
import type { TaskPaneState } from "../../shared/task-panes";
import { api } from "../rpc";
import { useT } from "../i18n";
import BottomSheet from "./BottomSheet";

interface PaneMapSheetProps {
	taskId: string;
	open: boolean;
	onClose: () => void;
	/** Jump to a pane by its backend-stable pane id and zoom it. */
	onJump: (paneId: string) => void | Promise<void>;
}

/**
 * Narrow-viewport "zoom-out" overview: a spatial mini-map of the active pane
 * set, positioned by each pane's normalized 0..1 rect. Works for both tmux
 * and native backends. Tap a box to jump to (and zoom) that pane.
 */
export default function PaneMapSheet({ taskId, open, onClose, onJump }: PaneMapSheetProps) {
	const t = useT();
	const [state, setState] = useState<TaskPaneState | null>(null);
	const [loading, setLoading] = useState(false);

	// Re-fetch the layout each time the sheet opens.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		(async () => {
			try {
				const res = await api.request.taskPaneState({ taskId });
				if (!cancelled) setState(res);
			} catch {
				if (!cancelled) setState(null);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, taskId]);

	const panes = state?.panes ?? [];
	// Standard landscape terminal aspect ratio (width/height) — cell ratio not
	// available in the neutral state, so we use a fixed 1.6 approximation.
	const aspect = 1.6;

	const paneLabel = (label: string, i: number) =>
		label.trim() || t("panePager.pane", { index: String(i + 1) });

	async function handleJump(paneId: string) {
		onClose();
		await onJump(paneId);
	}

	return (
		<BottomSheet open={open} onClose={onClose} title={t("paneMap.title")} testId="pane-map-sheet">
			{loading && !state ? (
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
							const label = paneLabel(p.label, i);
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
										left: `${p.rect.x * 100}%`,
										top: `${p.rect.y * 100}%`,
										width: `${p.rect.width * 100}%`,
										height: `${p.rect.height * 100}%`,
									}}
								>
									<span className="max-w-full truncate text-[0.7rem] font-medium leading-tight">{label}</span>
									{p.active && <span className="text-[0.6rem] leading-none opacity-80">{t("paneMap.current")}</span>}
								</button>
							);
						})}
					</div>
				</>
			)}
		</BottomSheet>
	);
}
