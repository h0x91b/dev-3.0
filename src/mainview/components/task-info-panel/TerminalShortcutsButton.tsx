import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { TmuxHintsIcon } from "../TmuxIcons";
import { subscribePaneState } from "../../pane-state-bus";
import type { TaskPaneState } from "../../../shared/task-panes";

/**
 * Opens the ⌘/ overlay's Terminal tab — the complete, searchable cheat sheet.
 *
 * It sits with the panel's own chrome (worktree config, fullscreen) rather than
 * with the pane controls: it mutates nothing and belongs next to the other
 * "tell me about this panel" affordances.
 *
 * Read-only subscriber to the pane bus, so it never polls: whether the task runs on
 * tmux or the native backend only changes the wording, and TaskPaneControls in the
 * same bar already keeps the shared state fresh.
 */
export default function TerminalShortcutsButton({ taskId }: { taskId: string }) {
	const t = useT();
	const [paneState, setPaneState] = useState<TaskPaneState | null>(null);

	useEffect(() => subscribePaneState(taskId, setPaneState), [taskId]);

	const title = paneState?.backend === "native" ? t("panes.nativeHintsTitle") : t("tmux.title");

	return (
		<button
			className="tmux-anim px-1.5 py-1 rounded text-fg-muted hover:text-fg-2 hover:bg-elevated border border-edge transition-colors flex items-center justify-center flex-shrink-0"
			onClick={(event) => {
				event.stopPropagation();
				window.dispatchEvent(new Event("menu:show-tmux-cheat-sheet"));
			}}
			title={title}
			aria-label={title}
		>
			<TmuxHintsIcon className="w-3.5 h-3.5" />
		</button>
	);
}
