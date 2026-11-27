/**
 * The task's own agent entry among its saved panes. The launch writes `main: true` and every
 * later agent writes `main: false`, so a dead main is never replaced by the entry at index 0.
 * Entries saved before the flag existed carry no `main` key anywhere: index 0 is the main there.
 */
export function mainPaneEntry<T extends { main?: boolean }>(panes: readonly T[]): T | undefined {
	return panes.find((pane) => pane.main === true) ?? (panes.some((pane) => pane.main !== undefined) ? undefined : panes[0]);
}
