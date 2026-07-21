import type { CompletedDiffStats, TaskStatus } from "../../shared/types";
import type { LifecycleColumn, LifecycleEvent, LifecycleRuntime } from "./events";

export const LIFECYCLE_PUSH_MESSAGES = [
	"taskUpdated",
	"taskSound",
	"taskRemoved",
	"taskPreparationFailed",
	"columnAgentFailed",
	"branchMerged",
	"taskPrStatus",
	"mergePromptResolved",
	"gitOpCompleted",
] as const;

export type LifecyclePushMessage = (typeof LIFECYCLE_PUSH_MESSAGES)[number];
export type EffectErrorPolicy = "continue" | "abort";

interface EffectPolicy {
	onError: EffectErrorPolicy;
	compensatingEvent?: LifecycleEvent;
}

export type LifecycleEffect =
	| ({ type: "clearMergeThrottle" } & EffectPolicy)
	| ({ type: "clearTaskRuntime" } & EffectPolicy)
	| ({ type: "releasePorts" } & EffectPolicy)
	| ({ type: "persistRuntime"; runtime: LifecycleRuntime } & EffectPolicy)
	| ({
		type: "prepareTask";
		runId: string;
		origin: LifecycleColumn;
		target: LifecycleColumn;
		isReopen: boolean;
	} & EffectPolicy)
	| ({ type: "destroyTaskPty" } & EffectPolicy)
	| ({ type: "killDevServer" } & EffectPolicy)
	| ({ type: "runCleanupScript"; toStatus: TaskStatus | "deleted" } & EffectPolicy)
	| ({ type: "captureCompletedDiffStats" } & EffectPolicy)
	| ({ type: "removeWorktree" } & EffectPolicy)
	| ({
		type: "persistColumn";
		column: LifecycleColumn;
		runtime?: LifecycleRuntime;
		worktreePath?: string;
		branchName?: string | null;
	} & EffectPolicy)
	| ({
		type: "persistTerminalTask";
		status: "completed" | "cancelled";
		completedDiffStats?: CompletedDiffStats;
	} & EffectPolicy)
	| ({ type: "persistPreparationStage"; stage: string; runId: string } & EffectPolicy)
	| ({ type: "persistPreparationFailure"; error: string | null } & EffectPolicy)
	| ({ type: "persistMergePrompt"; fingerprint: string; precise: boolean } & EffectPolicy)
	| ({ type: "persistPrStatus"; payload: unknown } & EffectPolicy)
	| ({ type: "launchColumnAgent"; column: LifecycleColumn } & EffectPolicy)
	| ({ type: "notifyStatusChange"; from: TaskStatus; to: TaskStatus } & EffectPolicy)
	| ({ type: "raisePrAttention"; reason: string } & EffectPolicy)
	| ({ type: "emitTaskSound"; status: "completed" | "cancelled" } & EffectPolicy)
	| ({
		type: "push";
		message: LifecyclePushMessage;
		view?: "current" | "shuttingDown";
		payload?: unknown;
	} & EffectPolicy);

