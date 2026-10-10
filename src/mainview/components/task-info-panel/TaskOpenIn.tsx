import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Task } from "../../../shared/types";
import { toggleFileExplorer, useFileExplorerPrefs } from "../../file-explorer-prefs";
import { useT } from "../../i18n";
import OpenInMenu from "../OpenInMenu";
import Tooltip from "../Tooltip";
import { OpenInIcon, FileTreeIcon } from "../TaskIcons";

interface TaskOpenInProps {
	task: Task;
	isTaskActive: boolean;
	showFileBrowser?: boolean;
	/** Icon-only rendering for a bar that is short on width. */
	compact?: boolean;
}

export default function TaskOpenIn({ task, isTaskActive, showFileBrowser = true, compact = false }: TaskOpenInProps) {
	const t = useT();
	const openInBtnRef = useRef<HTMLButtonElement>(null);
	const [openInMenuOpen, setOpenInMenuOpen] = useState(false);
	const [openInMenuPos, setOpenInMenuPos] = useState({ top: 0, left: 0 });
	const explorerShown = useFileExplorerPrefs().mode !== "hidden";

	function handleOpenInClick(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		if (openInBtnRef.current) {
			const rect = openInBtnRef.current.getBoundingClientRect();
			setOpenInMenuPos({ top: rect.bottom + 4, left: rect.left });
		}
		setOpenInMenuOpen(true);
	}

	if (!isTaskActive || !task.worktreePath) {
		return null;
	}

	return (
		<>
			<div className="relative flex-shrink-0">
				<Tooltip content={t("openIn.menuTitle")} detail={t("ttip.openIn.menu")}>
					<button
						ref={openInBtnRef}
						onClick={handleOpenInClick}
						className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-fg-3 hover:text-fg hover:bg-elevated border border-edge"
					>
						<OpenInIcon className="w-[1.05rem] h-[1.05rem]" />
						{!compact && <span className="text-micro font-semibold">{t("openIn.menuTitle")}</span>}
					</button>
				</Tooltip>
				{openInMenuOpen && (
					<OpenInMenu
						position={openInMenuPos}
						path={task.worktreePath}
						taskId={task.id}
						onClose={() => setOpenInMenuOpen(false)}
					/>
				)}
			</div>

			{showFileBrowser && (
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
			)}
		</>
	);
}
