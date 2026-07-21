import type { PreparingStage, TaskStatus } from "../../shared/types";

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

export type LifecycleEvent =
	| {
		type: "moveRequested";
		target: { status?: TaskStatus; customColumnId?: string | null };
		guards?: MoveGuards;
		force?: boolean;
		clientPlayedSound?: boolean;
		runId?: string;
	}
	| {
		type: "preparationRequested";
		runId: string;
		origin?: LifecycleColumn;
	}
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
	}
	| {
		type: "preparationFailed";
		runId: string;
		error: string;
	}
	| {
		type: "preparationCancelled";
		runId: string;
	}
	| {
		type: "mergeDetected";
		branchName: string;
		fingerprint: string;
		precise: boolean;
	}
	| {
		type: "prDetected";
		openNonDraft: boolean;
		payload: unknown;
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
		};
	};

