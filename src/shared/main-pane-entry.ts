/**
 * The task's own agent entry among its saved panes. The launch writes `main: true` and every
 * later agent writes `main: false`, so a dead main is never replaced by the entry at index 0.
 * A main saved before the flag existed has no `main` key and stands at index 0: it stays the
 * main while extras with `main: false` follow it.
 */
export function mainPaneEntry<T extends { main?: boolean }>(panes: readonly T[]): T | undefined {
	return panes.find((pane) => pane.main === true) ?? (panes[0]?.main === undefined ? panes[0] : undefined);
}
