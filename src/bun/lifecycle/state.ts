import type { PreparingStage, Project, Task } from "../../shared/types";
import type { LifecycleRuntime, LifecycleState } from "./events";

const PREPARING_STAGES = new Set<PreparingStage>([
	"resolving-config",
	"fetching-origin",
	"creating-worktree",
	"applying-sparse-checkout",
	"cloning-shared-paths",
	"launching-pty",
]);

function preparingStage(value: string | null | undefined): PreparingStage {
	return value && PREPARING_STAGES.has(value as PreparingStage)
		? value as PreparingStage
		: "resolving-config";
}

function runtimeFromTask(task: Task): LifecycleRuntime {
	const persisted = task.runtimeState;
	if (persisted?.runtime === "preparing") {
		return {
			phase: "preparing",
			stage: preparingStage(persisted.stage ?? task.preparingStage),
			runId: persisted.runId ?? `recovered-${task.id}`,
			origin: { status: task.status, customColumnId: task.customColumnId ?? null },
		};
	}
	if (persisted?.runtime === "tearing-down") {
		const targetStatus = persisted.stage === "cancelled" || task.status === "cancelled"
			? "cancelled"
			: "completed";
		return {
			phase: "tearing-down",
			targetStatus,
			runId: persisted.runId ?? `recovered-${task.id}`,
		};
	}
	if (persisted?.runtime === "running") return { phase: "running" };
	if (persisted?.runtime === "idle") return { phase: "idle" };

	if (task.preparing) {
		return {
			phase: "preparing",
			stage: preparingStage(task.preparingStage),
			runId: `legacy-${task.id}`,
			origin: { status: task.status, customColumnId: task.customColumnId ?? null },
		};
	}
	if (task.worktreePath && task.status !== "completed" && task.status !== "cancelled") {
		return { phase: "running" };
	}
	return { phase: "idle" };
}

export function lifecycleStateFromTask(project: Project, task: Task): LifecycleState {
	return {
		column: {
			status: task.status,
			customColumnId: task.customColumnId ?? null,
		},
		runtime: runtimeFromTask(task),
		facts: {
			hasWorktree: !!task.worktreePath,
			projectKind: project.kind === "virtual" ? "virtual" : "git",
			hasPrIdentity: task.prNumber != null,
			peerReviewEnabled: project.peerReviewEnabled !== false,
		},
	};
}
