import type { BoardColumnSlot, CodingAgent, Label, Project, Task, TaskPriority, TaskStatus } from "../../shared/types";
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

/** The mutations a view may perform (D4). Each one goes through the same confirm/approval flow as the rest of the app. */
export interface BoardActions {
	openTask(id: string): void;
	openContextMenu(id: string, at: { x: number; y: number }): void;
	moveTask(id: string, to: BoardMoveTarget): Promise<void>;
	setPriority(id: string, priority: TaskPriority): Promise<void>;
	setLabels(id: string, labelIds: string[]): Promise<void>;
	/** `projectId` is explicit: a space board spans projects, and a label belongs to one. */
	createLabel(projectId: string, name: string): Promise<Label>;
	createTask(init: { status?: TaskStatus; customColumnId?: string }): void;
	launch(id: string): Promise<void>;
	remove(id: string, kind: "cancel" | "delete"): Promise<void>;
}

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
	columns: BoardColumn[];
	labels: Label[];
	agents: CodingAgent[];
	projects: Project[];
	layout(viewId: string): unknown;
	setLayout(viewId: string, layout: unknown): void;
	actions: BoardActions;
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
	constructor(private readonly source: BoardModelSource) {}

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
	columns(): BoardColumn[] { return this.model.columns; }
	labels(): Label[] { return this.model.labels; }
	agents(): CodingAgent[] { return this.model.agents; }
	projects(): Project[] { return this.model.projects; }

	layout<T>(viewId: string): T | undefined { return this.model.layout(viewId) as T | undefined; }
	setLayout<T>(viewId: string, layout: T): void { this.model.setLayout(viewId, layout); }

	openTask(id: string): void { this.model.actions.openTask(id); }
	openContextMenu(id: string, at: { x: number; y: number }): void { this.model.actions.openContextMenu(id, at); }
	moveTask(id: string, to: BoardMoveTarget): Promise<void> { return this.model.actions.moveTask(id, to); }
	setPriority(id: string, priority: TaskPriority): Promise<void> { return this.model.actions.setPriority(id, priority); }
	setLabels(id: string, labelIds: string[]): Promise<void> { return this.model.actions.setLabels(id, labelIds); }
	createLabel(projectId: string, name: string): Promise<Label> { return this.model.actions.createLabel(projectId, name); }
	createTask(init: { status?: TaskStatus; customColumnId?: string } = {}): void { this.model.actions.createTask(init); }
	launch(id: string): Promise<void> { return this.model.actions.launch(id); }
	remove(id: string, kind: "cancel" | "delete"): Promise<void> { return this.model.actions.remove(id, kind); }
}
