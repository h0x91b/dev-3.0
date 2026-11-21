import { useT } from "../i18n";
import { BackIcon } from "./HeaderIcons";

interface BackToKanbanEmptyStateProps {
	/** Headline explaining why this pane has nothing to show. */
	message: string;
	/** Optional second line with the detail behind the headline. */
	hint?: string;
	onBack: () => void;
	testId?: string;
	/** Optional primary action shown before the way back (e.g. reopening a closed task). */
	action?: { label: string; onClick: () => void; testId?: string; disabled?: boolean };
}

/**
 * The dead-end pane of a task surface: no task selected, or the open task is
 * closed and its worktree is gone. Neither shows recovery buttons for a
 * workspace that no longer exists. A closed task may add one action, Reopen,
 * which builds a new session instead of recovering the old one.
 */
function BackToKanbanEmptyState({ message, hint, onBack, testId, action }: BackToKanbanEmptyStateProps) {
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
			<div className="flex items-center gap-2">
				{action && (
					<button
						type="button"
						data-testid={action.testId}
						onClick={action.onClick}
						disabled={action.disabled}
						className="px-3 py-1.5 rounded-md bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors text-sm disabled:opacity-50"
					>
						{action.label}
					</button>
				)}
				<button
					type="button"
					onClick={onBack}
					className="header-anim flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-edge bg-raised text-fg-3 hover:text-fg hover:bg-raised-hover hover:border-edge-active transition-colors text-sm"
				>
					<BackIcon className="w-3.5 h-3.5" />
					<span>{t("project.backToKanban")}</span>
				</button>
			</div>
		</div>
	);
}

export default BackToKanbanEmptyState;
