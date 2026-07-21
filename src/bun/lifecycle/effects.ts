import type { AppRPCSchema, CompletedDiffStats, TaskStatus } from "../../shared/types";
import type { LifecycleColumn, LifecycleEvent, LifecycleRuntime, LifecycleTaskPatch, PreparationLaunch } from "./events";

type BunMessagePayload<Name extends keyof AppRPCSchema["bun"]["messages"]> =
	AppRPCSchema["bun"]["messages"][Name];

export const LIFECYCLE_PUSH_MESSAGES = [
	"taskUpdated",
	"taskSound",
	"taskPreparationFailed",
	"columnAgentFailed",
	"branchMerged",
	"taskPrStatus",
	"mergePromptResolved",
] as const satisfies readonly (keyof AppRPCSchema["bun"]["messages"])[];

export type LifecyclePushMessage = (typeof LIFECYCLE_PUSH_MESSAGES)[number];
export type EffectErrorPolicy = "continue" | "abort";

interface EffectPolicy {
	onError: EffectErrorPolicy;
	compensatingEvent?: LifecycleEvent;
}

type LifecyclePushEffect = (
	| { type: "push"; message: "taskUpdated"; view: "current" | "shuttingDown" }
	| { type: "push"; message: "taskPreparationFailed"; payload: { error: string | null } }
	| {
		type: "push";
		message: "branchMerged";
		payload: {
			finding: Extract<LifecycleEvent, { type: "mergeDetected" }>;
			noticeOnly: boolean;
		};
	}
	| {
		type: "push";
		message: "taskPrStatus";
		payload: BunMessagePayload<"taskPrStatus">;
	}
	| {
		type: "push";
		message: "columnAgentFailed";
		payload: Extract<LifecycleEvent, { type: "columnAgentFailed" }>;
	}
	| {
		type: "push";
		message: "mergePromptResolved";
		payload: Extract<LifecycleEvent, { type: "mergePromptDismissed" }>;
	}
) & EffectPolicy;

export type LifecycleEffect =
	| ({ type: "reject"; message: string } & EffectPolicy)
	| ({ type: "clearMergeThrottle" } & EffectPolicy)
	| ({ type: "reserveMergePrompt"; fingerprint: string; reservedAt: number } & EffectPolicy)
	| ({ type: "setPrPromoted"; promoted: boolean } & EffectPolicy)
	| ({ type: "setPrSignalKey"; signalKey: string | null } & EffectPolicy)
	| ({ type: "clearTaskRuntime" } & EffectPolicy)
	| ({ type: "cancelPreparationProcesses" } & EffectPolicy)
	| ({ type: "releasePorts" } & EffectPolicy)
	| ({ type: "sendEvent"; event: LifecycleEvent } & EffectPolicy)
	| ({
		type: "persistRuntime";
		runtime: LifecycleRuntime;
		column?: LifecycleColumn;
		expectedColumn?: LifecycleColumn;
		taskPatch?: LifecycleTaskPatch;
	} & EffectPolicy)
	| ({ type: "persistTaskPatch"; taskPatch: LifecycleTaskPatch } & EffectPolicy)
	| ({
		type: "prepareTask";
		runId: string;
		origin: LifecycleColumn;
		target: LifecycleColumn;
		isReopen: boolean;
		awaitCompletion: boolean;
		columnReserved: boolean;
		successPatch: "activation" | "preparation";
		launch?: PreparationLaunch;
	} & EffectPolicy)
	| ({ type: "destroyTaskPty" } & EffectPolicy)
	| ({ type: "killDevServer" } & EffectPolicy)
	| ({ type: "runCleanupScript"; toStatus: TaskStatus | "deleted"; allowDerivedPath?: boolean } & EffectPolicy)
	| ({ type: "captureCompletedDiffStats"; allowDerivedPath?: boolean } & EffectPolicy)
	| ({ type: "removeWorktree"; allowDerivedPath?: boolean } & EffectPolicy)
	| ({ type: "removeTaskWorkspace"; allowDerivedPath?: boolean } & EffectPolicy)
	| ({ type: "deleteTaskRecord" } & EffectPolicy)
	| ({
		type: "persistColumn";
		column: LifecycleColumn;
		patch: "status" | "statusOnly" | "custom" | "activation" | "preparation";
		guards?: { ifStatus?: string; ifStatusNot?: string };
		writeOptions?: "none";
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
	| ({ type: "persistMergePrompt"; fingerprint: string; precise: boolean; promptedAt?: string } & EffectPolicy)
	| ({ type: "persistMergeDismissal"; fingerprint: string; precise: boolean; dismissedAt: string } & EffectPolicy)
	| ({ type: "persistPrStatus"; payload: unknown } & EffectPolicy)
	| ({ type: "launchColumnAgent"; column: LifecycleColumn } & EffectPolicy)
	| ({ type: "notifyStatusChange"; from: TaskStatus; to: TaskStatus } & EffectPolicy)
	| ({ type: "raisePrAttention"; reason: string } & EffectPolicy)
	| ({ type: "emitTaskSound"; status: "completed" | "cancelled" } & EffectPolicy)
	| LifecyclePushEffect;
