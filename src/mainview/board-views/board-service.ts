import type { ComponentType } from "react";
import type { BoardColumnSlot, CodingAgent, GlobalSettings, Label, Project, Task, TaskPriority, TaskStatus } from "../../shared/types";
import type { BoardFormFactor, BoardKind } from "../../shared/board-view-state";

export interface BoardScope {
	kind: BoardKind;
	id: string;
	projectIds: string[];
}

export type BoardColumn = BoardColumnSlot;

export interface BoardMoveTarget {
	status?: TaskStatus;
	customColumnId?: string;
	/** Reserved for in-column ordering; the board has no manual order yet. */
	index?: number;
}

export interface BoardMoveOptions {
	/** Told when the move's RPC is in flight (after any confirm), so the view can show the card as moving. */
	onMovingChange?(moving: boolean): void;
}

/** Board-level user preferences a view may honour. */
export interface BoardPreferences {
	taskSortOrder: GlobalSettings["taskSortOrder"];
	tipsDisabled: boolean;
}

/**
 * Props of `ctx.board.TaskCard`, the real dev3 task card. The host binds
 * everything else (its project, live signals, PR badge, lineage, launch flows),
 * so a view only says which task and how it is being dragged.
 */
export interface BoardTaskCardProps {
	task: Task;
	onDragStart?(taskId: string): void;
	isMoving?: boolean;
	onSetMoving?(taskId: string, moving: boolean): void;
}

/** Column management. Project boards only: on a space board each one rejects. */
export interface BoardColumnActions {
	/** Rename a built-in column; `null` restores the default name. */
	renameColumn(status: TaskStatus, name: string | null): Promise<void>;
	/** Create a custom column right before Completed; resolves its id, or null when it failed. */
	createColumn(): Promise<string | null>;
	renameCustomColumn(columnId: string, name: string): Promise<void>;
	/** Asks for confirmation first; its tasks go back to To Do. */
	deleteCustomColumn(columnId: string): Promise<void>;
	/** The full lane order: built-in statuses and custom column ids. */
	reorderColumns(order: string[]): Promise<void>;
}

/** The mutations a view may perform (D4). Each one goes through the same confirm/approval flow as the rest of the app. */
export interface BoardActions {
	openTask(id: string): void;
	openContextMenu(id: string, at: { x: number; y: number }): void;
	moveTask(id: string, to: BoardMoveTarget, opts?: BoardMoveOptions): Promise<void>;
	setPriority(id: string, priority: TaskPriority): Promise<void>;
	setLabels(id: string, labelIds: string[]): Promise<void>;
	/** `projectId` is explicit: a space board spans projects, and a label belongs to one. */
	createLabel(projectId: string, name: string): Promise<Label>;
	createTask(init: { status?: TaskStatus; customColumnId?: string }): void;
	launch(id: string): Promise<void>;
	remove(id: string, kind: "cancel" | "delete"): Promise<void>;
}

export type BoardAllActions = BoardActions & BoardColumnActions;

/**
 * Everything the host knows about the board on screen. The host rebuilds it on
 * every render from `state.ts`, so the service is a projection, never a second store.
 */
export interface BoardModel {
	scope: BoardScope;
	formFactor: BoardFormFactor;
	query: string;
	setQuery(query: string): void;
	scopeTasks: readonly Task[];
	tasks: readonly Task[];
	matches(task: Task, query: string): boolean;
	/** Lanes from project config alone. */
	columns: BoardColumn[];
	/** The same lanes plus any built-in the config hides but that still holds a card. */
	occupiedColumns: BoardColumn[];
	labels: Label[];
	agents: CodingAgent[];
	projects: Project[];
	layout(viewId: string): unknown;
	setLayout(viewId: string, layout: unknown): void;
	preferences: BoardPreferences;
	actions: BoardAllActions;
}

/** Mutable holder the host writes on render; the service reads it on every call. */
export interface BoardModelSource {
	current: BoardModel;
}

/**
 * `ctx.board`: the board on screen, for every board view. The host provides it
 * (`ctx.provide("board", …)`) while a board is mounted, so a plugin that injects
 * `board` is active exactly as long as there is a board to show. Provided with
 * `provide` rather than as a `Service` subclass because a plain provide is
 * synchronous and hands back its disposer. `board/changed` fires after each change.
 */
export class BoardService {
	constructor(
		private readonly source: BoardModelSource,
		private readonly cardComponent: ComponentType<BoardTaskCardProps>,
	) {}

	private get model(): BoardModel {
		return this.source.current;
	}

	get scope(): BoardScope { return this.model.scope; }
	get formFactor(): BoardFormFactor { return this.model.formFactor; }
	get query(): string { return this.model.query; }
	setQuery(query: string): void { this.model.setQuery(query); }

	/** Scope ∩ board query, every status included (D9). */
	tasks(): readonly Task[] { return this.model.tasks; }
	/** The scope unfiltered — for counts and "+N hidden". */
	scopeTasks(): readonly Task[] { return this.model.scopeTasks; }
	matches(task: Task, query: string): boolean { return this.model.matches(task, query); }
	/**
	 * The board's lanes in board order: built-in statuses and custom columns. The
	 * default is the config's set; `includeOccupied` adds a built-in the config
	 * hides but that still holds a card — what a board drawing lanes must show.
	 */
	columns(opts: { includeOccupied?: boolean } = {}): BoardColumn[] {
		return opts.includeOccupied ? this.model.occupiedColumns : this.model.columns;
	}
	labels(): Label[] { return this.model.labels; }
	agents(): CodingAgent[] { return this.model.agents; }
	projects(): Project[] { return this.model.projects; }
	preferences(): BoardPreferences { return this.model.preferences; }

	/** The real dev3 task card, bound by the host. A stable component type: safe to render directly. */
	get TaskCard(): ComponentType<BoardTaskCardProps> { return this.cardComponent; }

	layout<T>(viewId: string): T | undefined { return this.model.layout(viewId) as T | undefined; }
	setLayout<T>(viewId: string, layout: T): void { this.model.setLayout(viewId, layout); }

	openTask(id: string): void { this.model.actions.openTask(id); }
	openContextMenu(id: string, at: { x: number; y: number }): void { this.model.actions.openContextMenu(id, at); }
	moveTask(id: string, to: BoardMoveTarget, opts?: BoardMoveOptions): Promise<void> { return this.model.actions.moveTask(id, to, opts); }
	setPriority(id: string, priority: TaskPriority): Promise<void> { return this.model.actions.setPriority(id, priority); }
	setLabels(id: string, labelIds: string[]): Promise<void> { return this.model.actions.setLabels(id, labelIds); }
	createLabel(projectId: string, name: string): Promise<Label> { return this.model.actions.createLabel(projectId, name); }
	createTask(init: { status?: TaskStatus; customColumnId?: string } = {}): void { this.model.actions.createTask(init); }
	launch(id: string): Promise<void> { return this.model.actions.launch(id); }
	remove(id: string, kind: "cancel" | "delete"): Promise<void> { return this.model.actions.remove(id, kind); }

	renameColumn(status: TaskStatus, name: string | null): Promise<void> { return this.model.actions.renameColumn(status, name); }
	createColumn(): Promise<string | null> { return this.model.actions.createColumn(); }
	renameCustomColumn(columnId: string, name: string): Promise<void> { return this.model.actions.renameCustomColumn(columnId, name); }
	deleteCustomColumn(columnId: string): Promise<void> { return this.model.actions.deleteCustomColumn(columnId); }
	reorderColumns(order: string[]): Promise<void> { return this.model.actions.reorderColumns(order); }
}
