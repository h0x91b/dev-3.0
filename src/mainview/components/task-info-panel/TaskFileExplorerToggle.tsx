import type { Task } from "../../../shared/types";
import { toggleFileExplorer, useFileExplorerPrefs } from "../../file-explorer-prefs";
import { useT } from "../../i18n";
import Tooltip from "../Tooltip";
import { FileTreeIcon } from "../TaskIcons";

/** Shows or hides the worktree file explorer; only a task with a live worktree has one. */
export default function TaskFileExplorerToggle({ task, isTaskActive }: { task: Task; isTaskActive: boolean }) {
	const t = useT();
	const explorerShown = useFileExplorerPrefs().mode !== "hidden";
	if (!isTaskActive || !task.worktreePath) {
		return null;
	}
	return (
		<div className="relative flex-shrink-0">
			<Tooltip content={t("header.fileBrowser")} detail={t("ttip.openIn.fileBrowser")}>
				<button
					onClick={toggleFileExplorer}
					className={`task-anim flex items-center justify-center px-2 py-1 rounded-lg transition-colors flex-shrink-0 border border-edge hover:bg-elevated ${
						explorerShown ? "text-accent hover:text-accent-emphasis" : "text-fg-3 hover:text-fg"
					}`}
					aria-label={t("header.fileBrowser")}
					aria-pressed={explorerShown}
				>
					<FileTreeIcon className="w-[1.125rem] h-[1.125rem]" />
				</button>
			</Tooltip>
		</div>
	);
}
