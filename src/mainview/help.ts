import type { TranslationKey } from "./i18n";
import type { TaskStatus } from "../shared/types";

/**
 * Single source of truth for every inline-help topic (bible §5.4).
 *
 * Like `keymap.ts` and `tips.ts`, this registry declares help content as data:
 * the same topics feed the section-level `HelpSpot` (i) buttons, the
 * screen-wide help-mode overlay (`HelpOverlay`), and any future docs surface.
 * Help copy is NEVER hardcoded in components — components reference a topic id
 * and the card renders from here.
 *
 * A zone participates in help mode by carrying `data-help-id="<topic id>"` on
 * its container element (mirrors the hint overlay's `data-hint-id`).
 *
 * Coverage law + correlation invariant (bible §5.4): every user-facing
 * surface/section and every non-self-evident form field (`field.*` namespace)
 * must have a topic reachable in help mode, shipped in the same commit as the
 * UI. Every registry-backed HelpSpot auto-renders its `data-help-id`, and
 * `__tests__/help.test.ts` fails on dangling ids and orphan topics.
 */

/** Navigation-only actions a HelpCard link may trigger (read-only surface). */
export type HelpLinkAction = "open-keyboard-shortcuts" | "enter-help-mode";

export interface HelpTopic {
	/** Stable, unique id; also the `data-help-id` value for help-mode zones. */
	id: string;
	titleKey: TranslationKey;
	bodyKey: TranslationKey;
	/**
	 * Ids from `keymap.ts` rendered as shortcut chips on the card.
	 * Validated against the keymap registry by a test.
	 */
	shortcutIds?: string[];
	/** Optional navigation link at the card's bottom. */
	link?: { labelKey: TranslationKey; action: HelpLinkAction };
}

export const HELP_TOPICS: HelpTopic[] = [
	// ── Board columns ──
	{ id: "board.column.todo", titleKey: "help.board.column.todo.title", bodyKey: "help.board.column.todo.body" },
	{ id: "board.column.in-progress", titleKey: "help.board.column.inProgress.title", bodyKey: "help.board.column.inProgress.body" },
	{ id: "board.column.user-questions", titleKey: "help.board.column.userQuestions.title", bodyKey: "help.board.column.userQuestions.body" },
	{ id: "board.column.review-by-ai", titleKey: "help.board.column.reviewByAi.title", bodyKey: "help.board.column.reviewByAi.body" },
	{ id: "board.column.review-by-user", titleKey: "help.board.column.reviewByUser.title", bodyKey: "help.board.column.reviewByUser.body" },
	{ id: "board.column.review-by-colleague", titleKey: "help.board.column.reviewByColleague.title", bodyKey: "help.board.column.reviewByColleague.body" },
	{ id: "board.column.completed", titleKey: "help.board.column.completed.title", bodyKey: "help.board.column.completed.body" },
	{ id: "board.column.cancelled", titleKey: "help.board.column.cancelled.title", bodyKey: "help.board.column.cancelled.body" },

	// ── Board chrome ──
	{
		id: "board.filter-bar",
		titleKey: "help.board.filterBar.title",
		bodyKey: "help.board.filterBar.body",
		shortcutIds: ["focus-search"],
	},
	{
		id: "board.priority-filter",
		titleKey: "help.board.priorityFilter.title",
		bodyKey: "help.board.priorityFilter.body",
	},
	{
		id: "filters.dsl",
		titleKey: "help.filters.dsl.title",
		bodyKey: "help.filters.dsl.body",
		shortcutIds: ["focus-search"],
	},
	{ id: "board.task-card", titleKey: "help.board.taskCard.title", bodyKey: "help.board.taskCard.body" },

	// ── Dashboard ──
	{ id: "dashboard.projects", titleKey: "help.dashboard.projects.title", bodyKey: "help.dashboard.projects.body" },
	{ id: "dashboard.stats-entry", titleKey: "help.dashboard.statsEntry.title", bodyKey: "help.dashboard.statsEntry.body" },
	{ id: "dashboard.project-row", titleKey: "help.dashboard.projectRow.title", bodyKey: "help.dashboard.projectRow.body" },

	// ── Task inspector ──
	{
		id: "inspector.panel",
		titleKey: "help.inspector.panel.title",
		bodyKey: "help.inspector.panel.body",
		link: { labelKey: "help.ui.explainScreen", action: "enter-help-mode" },
	},
	{ id: "inspector.context-bar", titleKey: "help.inspector.contextBar.title", bodyKey: "help.inspector.contextBar.body" },
	{ id: "inspector.session-bar", titleKey: "help.inspector.sessionBar.title", bodyKey: "help.inspector.sessionBar.body" },
	{ id: "inspector.git-bar", titleKey: "help.inspector.gitBar.title", bodyKey: "help.inspector.gitBar.body" },
	{ id: "inspector.runtime-bar", titleKey: "help.inspector.runtimeBar.title", bodyKey: "help.inspector.runtimeBar.body" },

	// ── Diff viewer ──
	{ id: "diff.modes", titleKey: "help.diff.modes.title", bodyKey: "help.diff.modes.body" },
	{ id: "diff.review", titleKey: "help.diff.review.title", bodyKey: "help.diff.review.body" },

	// ── Settings sections ──
	{ id: "settings.agents", titleKey: "help.settings.agents.title", bodyKey: "help.settings.agents.body" },
	{ id: "settings.appearance", titleKey: "help.settings.appearance.title", bodyKey: "help.settings.appearance.body" },
	{ id: "settings.tasks", titleKey: "help.settings.tasks.title", bodyKey: "help.settings.tasks.body" },
	{ id: "settings.terminal", titleKey: "help.settings.terminal.title", bodyKey: "help.settings.terminal.body" },
	{ id: "settings.accounts", titleKey: "help.settings.accounts.title", bodyKey: "help.settings.accounts.body" },
	{ id: "settings.system", titleKey: "help.settings.system.title", bodyKey: "help.settings.system.body" },
	{ id: "settings.workspace", titleKey: "help.settings.workspace.title", bodyKey: "help.settings.workspace.body" },
	{ id: "settings.devtools", titleKey: "help.settings.devtools.title", bodyKey: "help.settings.devtools.body" },

	// ── Stats ──
	{ id: "stats.overview", titleKey: "help.stats.overview.title", bodyKey: "help.stats.overview.body" },

	// ── Modals ──
	{ id: "modal.create-task", titleKey: "help.modal.createTask.title", bodyKey: "help.modal.createTask.body" },
	{ id: "modal.launch-variants", titleKey: "help.modal.launchVariants.title", bodyKey: "help.modal.launchVariants.body" },

	// ── Form fields ──
	{ id: "field.task-branch", titleKey: "help.field.taskBranch.title", bodyKey: "help.field.taskBranch.body" },

	// ── Header / sidebar ──
	{
		id: "header.utilities",
		titleKey: "help.header.utilities.title",
		bodyKey: "help.header.utilities.body",
		link: { labelKey: "help.ui.openShortcuts", action: "open-keyboard-shortcuts" },
	},
	{ id: "header.rateLimits", titleKey: "help.header.rateLimits.title", bodyKey: "help.header.rateLimits.body" },
	{ id: "sidebar.active-tasks", titleKey: "help.sidebar.activeTasks.title", bodyKey: "help.sidebar.activeTasks.body" },
];

const TOPIC_BY_ID = new Map(HELP_TOPICS.map((topic) => [topic.id, topic]));

/** DOM event used to deliver HelpCard link actions to App-level handlers. */
export const HELP_LINK_ACTION_EVENT = "help:link-action";

/**
 * Fire a HelpCard navigation link action. `App.tsx` listens and routes:
 * `open-keyboard-shortcuts` → shortcuts modal, `enter-help-mode` → HelpOverlay.
 * An event (not prop drilling) so any surface can host a HelpSpot without
 * plumbing callbacks through the tree.
 */
export function dispatchHelpLinkAction(action: HelpLinkAction): void {
	window.dispatchEvent(new CustomEvent(HELP_LINK_ACTION_EVENT, { detail: action }));
}

export function helpTopic(id: string): HelpTopic | undefined {
	return TOPIC_BY_ID.get(id);
}

/** The board-column help topic for a task status. */
export function statusHelpTopicId(status: TaskStatus): string {
	return `board.column.${status}`;
}
