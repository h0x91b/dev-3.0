import type { Context } from "cordis";
import type { ReactNode } from "react";
import type { Project, Space, Task } from "../../shared/types";
import type { TFunction } from "../i18n";
import type { GoToMode } from "../components/GoToPalette";
import type { useProjectPrivacy } from "../sensitive-projects";
import type { TaskQueryContext } from "../utils/taskSearch";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotItem } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `goToSources`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/22/go-to-sources-slot.md).
declare module "cordis" {
	interface Context {
		goToSources: GoToSourceRegistry;
	}
}

/** What a source builds rows from. Rebuilt only when this data changes, never per keystroke. */
export interface GoToData {
	/** Non-deleted projects, recency-first. */
	projects: readonly Project[];
	spaces: readonly Space[];
	/** The cross-project task pool, recency-first; empty until loaded, and outside task-bearing modes. */
	tasks: readonly Task[];
	projectById: ReadonlyMap<string, Project>;
	t: TFunction;
	/** The task's facet context for `matchesTaskQuery`, cached per task. */
	taskContext: (task: Task) => TaskQueryContext;
}

/** What a row draws and does: the data plus what only the open palette knows. */
export interface GoToView extends GoToData {
	privacy: ReturnType<typeof useProjectPrivacy>;
	/** Project or space id → 0-based ⌘N index. */
	shortcutIndexById?: Record<string, number>;
	openProject: (projectId: string) => void;
	openSpace: (spaceId: string) => void;
	openTask: (task: Task) => void;
}

/** The typed query, parsed once per keystroke by the host. */
export interface GoToQuery {
	raw: string;
	/** The free text left after task tokens. */
	free: string;
	/** A task-only token (`label:`, `status:` …) is present: non-task rows drop out. */
	hasTaskFacet: boolean;
}

/** One palette row a source produced. `id` orders the "All" timeline: `p:<id>` and `t:<id>` are visit keys. */
export interface GoToRow<Value = unknown> {
	id: string;
	/** The label the row highlights and the free text ranks on by default. */
	text: string;
	value: Value;
}

/**
 * A provider of palette rows. The host merges every source shown in a mode in
 * slot order, interleaves "All" by the visit timeline, ranks on free text and
 * draws the list; a source only says what its rows are and whether they match.
 */
export interface GoToSourceItem<Value = unknown> extends SlotItem {
	modes: readonly GoToMode[];
	rows: (data: GoToData) => GoToRow<Value>[];
	matches: (row: GoToRow<Value>, query: GoToQuery, data: GoToData) => boolean;
	/** A wider haystack to rank on; must start with `text` so the highlight stays aligned. */
	rankText?: (row: GoToRow<Value>, data: GoToData) => string;
	textClassName?: (row: GoToRow<Value>, view: GoToView) => string;
	/** Trailing content: a badge, the owning project, a lock. */
	right?: (row: GoToRow<Value>, query: string, view: GoToView) => ReactNode;
	select: (row: GoToRow<Value>, view: GoToView) => void;
}

/** The slot holds sources of every row type; each source types its own `value`. */
export type AnyGoToSource = GoToSourceItem<any>;

export type GoToSourceCallback = "rows" | "matches" | "rankText" | "textClassName" | "right" | "render" | "select";

let reported = new WeakMap<AnyGoToSource, Set<GoToSourceCallback>>();

/** Runs one source callback; a throw falls back and is reported (see `reportGoToSourceFailure`). */
export function guardGoToSource<T>(source: AnyGoToSource, callback: GoToSourceCallback, run: () => T, fallback: T): T {
	try {
		return run();
	} catch (err) {
		reportGoToSourceFailure(source, callback, err);
		return fallback;
	}
}

/**
 * Render-path callbacks run on every keystroke, so each is logged once per source. A
 * `select` is one click, so every failing one is logged: a transient failure must not go silent.
 */
export function reportGoToSourceFailure(source: AnyGoToSource, callback: GoToSourceCallback, err: unknown): void {
	if (callback !== "select") {
		const seen = reported.get(source) ?? new Set<GoToSourceCallback>();
		reported.set(source, seen);
		if (seen.has(callback)) return;
		seen.add(callback);
	}
	console.error(`[goToSources] ${callback} of go-to source ${source.id} threw:`, err);
}

export function resetGoToSourceFailuresForTests(): void {
	reported = new WeakMap();
}

export class GoToSourceRegistry extends SlotRegistry<AnyGoToSource> {
	constructor(ctx: Context) {
		super(ctx, "goToSources", { kind: "contribute", noun: "go-to source" });
	}
}

export const getGoToSourceRegistry = defineAppSlot((root) => new GoToSourceRegistry(root));
