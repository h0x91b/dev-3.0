import type { Dispatch } from "react";
import type { Project, Task } from "../../../shared/types";
import type { AppAction, Route } from "../../state";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { openFolderPicker } from "../../folder-picker";
import { toast } from "../../toast";
import Tooltip from "../Tooltip";
import type { TaskInlineDiffRequest } from "../task-inline-diff";
import TaskGitActions, { type TaskBranchStatusMeta } from "./TaskGitActions";

interface TaskOpsRepoBarProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	isTaskActive: boolean;
	showLoading?: boolean;
	compact?: boolean;
	onBranchStatusChange?: (meta: TaskBranchStatusMeta) => void;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
}

const ATTACH_BTN_CLASS =
	"inline-flex items-center justify-center px-1.5 py-0.5 rounded text-dense font-medium flex-shrink-0 transition-[color,background-color,transform] active:scale-[0.96] text-fg-3 hover:text-fg hover:bg-elevated border border-edge";

/**
 * The Git bar of an Operations task: attach a local repo to read its diff here,
 * or, once attached, the read-only changes summary with the repo chip.
 */
export default function TaskOpsRepoBar({ task, isTaskActive, ...gitProps }: TaskOpsRepoBarProps) {
	const t = useT();

	async function setRepo(path: string | null) {
		try {
			await api.request.setTaskAttachedRepo({ taskId: task.id, projectId: task.projectId, path });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err), { taskId: task.id });
		}
	}

	async function attach() {
		let folder: string | null;
		try {
			folder = await openFolderPicker({ initialPath: task.worktreePath });
		} catch {
			return;
		}
		if (folder) await setRepo(folder);
	}

	if (!task.attachedRepo) {
		return (
			<>
				<span className="text-fg-muted text-micro italic flex-shrink-0 truncate">{t("ops.gitUnavailable")}</span>
				{isTaskActive && (
					<Tooltip content={t("ops.attachRepoTooltip")}>
						<button type="button" onClick={() => void attach()} className={ATTACH_BTN_CLASS}>
							{t("ops.attachRepo")}
						</button>
					</Tooltip>
				)}
			</>
		);
	}

	const repoName = task.attachedRepo.split(/[\\/]/).filter(Boolean).pop() ?? task.attachedRepo;
	return (
		<>
			<span
				className="inline-flex items-center gap-1 flex-shrink-0 rounded px-1.5 py-0.5 text-micro border border-edge bg-raised/60 text-fg-3"
				data-testid="attached-repo-chip"
			>
				<svg aria-hidden className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
				</svg>
				<Tooltip content={task.attachedRepo}>
					<span className="font-medium truncate max-w-[160px]">{repoName}</span>
				</Tooltip>
				{!task.opsWorktree && (
					<Tooltip content={t("ops.detachRepo")}>
						<button
							type="button"
							onClick={() => void setRepo(null)}
							className="flex-shrink-0 text-fg-muted hover:text-fg rounded hover:bg-elevated active:scale-[0.96] transition-[color,background-color,transform]"
							aria-label={t("ops.detachRepo")}
						>
							<svg aria-hidden className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</Tooltip>
				)}
			</span>
			<TaskGitActions task={task} isTaskActive={isTaskActive} readOnly {...gitProps} />
		</>
	);
}
