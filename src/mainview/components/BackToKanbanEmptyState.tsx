import { useT } from "../i18n";

interface BackToKanbanEmptyStateProps {
	/** Headline explaining why this pane has nothing to show. */
	message: string;
	/** Optional second line with the detail behind the headline. */
	hint?: string;
	onBack: () => void;
	testId?: string;
}

/**
 * The dead-end pane of a task surface: no task selected, or the open task is
 * closed and its worktree is gone. Both cases offer exactly one way out, so
 * they share this state instead of showing recovery buttons for a workspace
 * that no longer exists.
 */
function BackToKanbanEmptyState({ message, hint, onBack, testId }: BackToKanbanEmptyStateProps) {
	const t = useT();
	return (
		<div
			data-testid={testId}
			className="h-full w-full flex flex-col items-center justify-center gap-4 bg-base px-6 text-center"
		>
			<div className="space-y-1">
				<p className="text-fg-muted text-sm">{message}</p>
				{hint && <p className="text-fg-muted text-xs max-w-sm">{hint}</p>}
			</div>
			<button
				type="button"
				onClick={onBack}
				className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-edge bg-raised text-fg-3 hover:text-fg hover:bg-raised-hover hover:border-edge-active transition-colors text-sm"
			>
				<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
				</svg>
				<span>{t("project.backToKanban")}</span>
			</button>
		</div>
	);
}

export default BackToKanbanEmptyState;
