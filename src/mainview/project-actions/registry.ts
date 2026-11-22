import type { Context } from "cordis";
import type { Project } from "../../shared/types";
import type { TFunction } from "../i18n";
import type { Route } from "../state";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotEntry } from "../plugins/slot-registry";
import { isBuiltinItem } from "../plugins/SlotItems";
import { reportResolveFailure, resolveMenuRow, type MenuRow, type MenuSlotItem } from "../plugins/menu-rows";

// Internal for now: no manifest kind declares `projectActions`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/22/project-actions-slot.md).
declare module "cordis" {
	interface Context {
		projectActions: ProjectActionRegistry;
	}
}

const SLOT = "projectActions";

/** Where a dashboard project's actions are drawn: the wide row's icon cluster, or the narrow kebab's sheet. */
export type ProjectActionPlacement = "row" | "sheet";

/** `danger` items are drawn last by the host, whatever their `order`. */
export type ProjectActionGroup = "actions" | "danger";

/** What an item sees: the project, where it is drawn, and what the dashboard offers. */
export interface ProjectActionScope {
	project: Project;
	placement: ProjectActionPlacement;
	t: TFunction;
	navigate: (route: Route) => void;
	/** The space-membership picker, anchored to the clicked button; absent while no space exists. */
	openSpaces?: (anchor: HTMLElement) => void;
	/** Removal through the dashboard's own confirmation; absent where the host offers none. */
	removeProject?: () => void | Promise<void>;
	/** The button that was clicked, once there is a click. */
	anchor: HTMLElement | null;
}

/** One per-project action. The host draws it as an icon button or a sheet row; it only runs itself. */
export interface ProjectActionItem extends Omit<MenuSlotItem<ProjectActionScope, ProjectActionGroup>, "disabled" | "checked" | "danger"> {
	placements: readonly ProjectActionPlacement[];
	/** One Nerd Font glyph. */
	glyph: string;
	/** Row button test id, suffixed with the project id. */
	testIdPrefix?: string;
	run: (scope: ProjectActionScope) => void | Promise<void>;
}

export class ProjectActionRegistry extends SlotRegistry<ProjectActionItem> {
	constructor(ctx: Context) {
		super(ctx, SLOT, { kind: "contribute", noun: "project action" });
	}
}

export const getProjectActionRegistry = defineAppSlot((root) => new ProjectActionRegistry(root));

export interface ProjectActionRows {
	/** dev3's own actions, in `order`. */
	actions: MenuRow<ProjectActionItem>[];
	/** Everyone else's, kept apart so a host can budget them (none on the row today); never styled as danger. */
	foreign: MenuRow<ProjectActionItem>[];
	/** dev3's destructive actions: always last. */
	danger: MenuRow<ProjectActionItem>[];
}

export type ProjectActionEntries = readonly Pick<SlotEntry<ProjectActionItem>, "def">[];

/** Resolves the items drawn at one placement; a throwing or malformed item drops only itself, logged once. */
export function resolveProjectActions(entries: ProjectActionEntries, scope: ProjectActionScope): ProjectActionRows {
	const rows: ProjectActionRows = { actions: [], foreign: [], danger: [] };
	for (const { def } of entries) {
		try {
			if (!Array.isArray(def.placements)) throw new TypeError("a project action needs a placements array");
			if (!def.placements.includes(scope.placement)) continue;
			const row = resolveMenuRow(SLOT, def, scope);
			if (!row) continue;
			if (typeof row.label !== "string" || typeof def.glyph !== "string") throw new TypeError("a project action needs a string label and glyph");
			if (!isBuiltinItem(def.id)) rows.foreign.push(row);
			else if (def.region === "danger") rows.danger.push(row);
			else rows.actions.push(row);
		} catch (err) {
			reportResolveFailure(SLOT, def.id, err);
		}
	}
	return rows;
}
