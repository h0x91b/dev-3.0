import { useState } from "react";
import type { PreparingStage, Project, Task } from "../../shared/types";
import { getPreparingStageProgress } from "../../shared/types";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";

export const PREPARING_STAGE_LABELS = {
	"resolving-config": "task.preparingStage.resolvingConfig",
	"fetching-origin": "task.preparingStage.fetchingOrigin",
	"creating-worktree": "task.preparingStage.creatingWorktree",
	"applying-sparse-checkout": "task.preparingStage.applyingSparseCheckout",
	"cloning-shared-paths": "task.preparingStage.cloningSharedPaths",
	"launching-pty": "task.preparingStage.launchingPty",
} as const satisfies Record<PreparingStage, string>;

interface TaskPreparingViewProps {
	task: Task;
	project: Project;
	/** Called with the reverted (todo) task after the user cancels preparation. */
	onCancelled?: (task: Task) => void;
}

/**
 * Full-pane loading state shown in the main task view while a task's worktree
 * is still being created (git clone, sparse checkout, etc.). Mirrors the
 * compact preparing overlay on the Kanban card so clicking a still-preparing
 * task surfaces progress instead of a stale/empty terminal.
 */
function TaskPreparingView({ task, project, onCancelled }: TaskPreparingViewProps) {
	const t = useT();
	const [cancelling, setCancelling] = useState(false);

	const stage = task.preparingStage ?? "resolving-config";
	const progress = Math.max(
		4,
		Math.min(
			100,
			typeof task.preparingProgress === "number" ? task.preparingProgress : getPreparingStageProgress(stage),
		),
	);
	const stageLabel = t(PREPARING_STAGE_LABELS[stage]);

	async function handleCancel() {
		if (cancelling) return;
		setCancelling(true);
		try {
			const updated = await api.request.cancelTaskPreparation({ taskId: task.id, projectId: project.id });
			onCancelled?.(updated);
		} catch (err) {
			toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
			setCancelling(false);
		}
	}

	return (
		<div className="flex items-center justify-center h-full">
			<div className="bg-raised border border-edge rounded-lg p-6 max-w-md w-full space-y-4">
				<div className="flex items-center gap-2 font-medium text-fg">
					<div className="w-4 h-4 border-2 border-fg-muted/30 border-t-accent rounded-full animate-spin" />
					<span>{t("task.preparing")}</span>
				</div>
				<div className="text-fg-2 text-sm">{stageLabel}</div>
				<div
					className="h-1.5 w-full overflow-hidden rounded-full bg-fg/10"
					role="progressbar"
					aria-label={t("task.preparing")}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={progress}
					aria-valuetext={stageLabel}
				>
					<div
						className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
						style={{ width: `${progress}%` }}
					/>
				</div>
				<div className="flex justify-end pt-2">
					<button
						onClick={handleCancel}
						disabled={cancelling}
						className="px-4 py-2 bg-danger/10 text-danger rounded text-sm font-medium hover:bg-danger/20 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
					>
						{t("task.cancel")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default TaskPreparingView;
