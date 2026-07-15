import { useT } from "../i18n";

interface TaskShutdownOverlayProps {
	/** Use the single-line treatment for the narrow active-task strip. */
	strip?: boolean;
}

/** Shared teardown feedback for task surfaces while the worktree is closing. */
function TaskShutdownOverlay({ strip = false }: TaskShutdownOverlayProps) {
	const t = useT();

	if (strip) {
		return (
			<div
				className="absolute inset-0 z-10 flex items-center justify-center rounded bg-base/80"
				role="status"
				aria-label={t("task.shuttingDown")}
				aria-live="polite"
				aria-busy="true"
				title={t("task.shuttingDownDetail")}
			>
				<div className="h-3 w-3 rounded-full border-2 border-fg-muted/30 border-t-fg-muted animate-spin motion-reduce:animate-none" />
			</div>
		);
	}

	return (
		<div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-base/55 px-3 backdrop-blur-[2px]">
			<div
				className="flex max-w-full items-center gap-2 rounded-xl border border-edge bg-overlay/95 px-3 py-2 shadow-xl shadow-black/30"
				role="status"
				aria-live="polite"
				aria-busy="true"
			>
				<div className="h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 border-fg-muted/30 border-t-fg-muted animate-spin motion-reduce:animate-none" />
				<div className="min-w-0">
					<div className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-fg-3">
						{t("task.shuttingDown")}
					</div>
					<div className="truncate text-xs text-fg-muted">
						{t("task.shuttingDownDetail")}
					</div>
				</div>
			</div>
		</div>
	);
}

export default TaskShutdownOverlay;
