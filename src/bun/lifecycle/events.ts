import type { AppRPCSchema, PreparingStage, Task, TaskStatus } from "../../shared/types";

export interface LifecycleColumn {
	status: TaskStatus;
	customColumnId: string | null;
}

export type LifecycleRuntime =
	| { phase: "idle" }
	| { phase: "running" }
	| {
		phase: "preparing";
		stage: PreparingStage;
		runId: string;
		origin: LifecycleColumn;
	}
	| {
		phase: "tearing-down";
		targetStatus: "completed" | "cancelled";
		runId: string;
	};

export interface LifecycleFacts {
	hasWorktree: boolean;
	projectKind: "git" | "virtual";
	hasPrIdentity: boolean;
	peerReviewEnabled: boolean;
	manualCompletion?: boolean;
	mergeCompletionPrompt?: Task["mergeCompletionPrompt"];
	mergePromptReservation?: { fingerprint: string; reservedAt: number };
	prPromoted?: boolean;
	prSignalKey?: string;
}

export interface LifecycleState {
	column: LifecycleColumn;
	runtime: LifecycleRuntime;
	facts: LifecycleFacts;
}

export interface MoveGuards {
	ifStatus?: string;
	ifStatusNot?: string;
}

export interface PreparationLaunch {
	label: string;
	agentId: string | null;
	configId: string | null;
	existingBranch?: string;
	variantBranchName?: string;
}

export type LifecycleTaskPatch = Partial<Pick<
	Task,
	| "groupId"
	| "variantIndex"
	| "agentId"
	| "configId"
	| "accountId"
	| "existingBranch"
	| "worktreePath"
	| "branchName"
	| "scheduledLaunch"
	| "preparationError"
>>;

export type LifecycleEvent =
	| {
		type: "moveRequested";
		target: { status?: TaskStatus; customColumnId?: string | null };
		cause?: "pr-promotion" | "column-agent-fallback";
		enforceAllowedTransition?: boolean;
		guards?: MoveGuards;
		force?: boolean;
		clientPlayedSound?: boolean;
		launchColumnAgent?: boolean;
		runId?: string;
		taskPatch?: LifecycleTaskPatch;
		preparation?: {
			launch: PreparationLaunch;
			awaitCompletion: boolean;
			publishColumn: boolean;
		};
	}
	| { type: "deleteRequested" }
	| {
		type: "preparationStageChanged";
		runId: string;
		stage: PreparingStage;
	}
	| {
		type: "preparationSucceeded";
		runId: string;
		worktreePath: string;
		branchName: string | null;
		origin: LifecycleColumn;
		target: LifecycleColumn;
		mode: "activation" | "preparation";
		columnReserved?: boolean;
	}
	| {
		type: "preparationFailed";
		runId: string;
		error: string;
		origin?: LifecycleColumn;
		target?: LifecycleColumn;
		compensating?: boolean;
	}
	| {
		type: "preparationCancelled";
		runId: string;
	}
	| {
		type: "teardownFailed";
		runId: string;
		error: string;
	}
	| {
		type: "mergeDetected";
		branchName: string;
		fingerprint: string;
		precise: boolean;
		detectedAt: string;
		suggestCompletion: boolean;
	}
	| {
		type: "mergePromptPrepared";
		fingerprint: string;
		precise: boolean;
		promptedAt: string;
		suggestCompletion: boolean;
		force?: boolean;
	}
	| {
		type: "mergePromptDismissed";
		fingerprint: string;
		precise: boolean;
		dismissedAt: string;
	}
	| {
		type: "prIdentityDiscovered";
		prNumber: number;
		prUrl: string;
	}
	| {
		type: "prDetected";
		openNonDraft: boolean;
		payload: AppRPCSchema["bun"]["messages"]["taskPrStatus"];
		persistence?: {
			prNumber: number;
			prUrl: string;
			cache: NonNullable<Task["prStatusCache"]>;
		};
		signalKey?: string | null;
		signalReason?: string;
	}
	| {
		type: "columnAgentFailed";
		columnName: string;
		error: string;
	}
	| {
		type: "bootObserved";
		reality: {
			worktreeExists: boolean;
			tmuxAlive: boolean;
			worktreePath?: string | null;
			branchName?: string | null;
		};
	};
