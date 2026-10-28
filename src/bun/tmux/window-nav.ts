import type { TmuxWindowEntry } from "../../shared/types";
import type { WINDOW_PANE_FORMAT, TmuxFormatRow, WINDOW_SWITCHER_FORMAT } from "./formats";

export type WindowRow = TmuxFormatRow<typeof WINDOW_SWITCHER_FORMAT>;
export type AgentPaneRow = TmuxFormatRow<typeof WINDOW_PANE_FORMAT>;

// Agent CLIs prefix their pane title with a status glyph (Claude: "✳ ", or a
// braille spinner frame while working). It flickers, so it never reaches a label.
const STATUS_GLYPH_PREFIX = /^[^\p{L}\p{N}\s]\s+/u;

/**
 * The one naming rule for a window: the active pane's title when something set
 * it (tmux defaults it to the hostname, which names nothing), else the window
 * name (tmux auto-renames it after the running command), else "".
 */
export function windowLabel(row: Pick<WindowRow, "title" | "hostShort" | "name">): string {
	const title = row.title.trim().replace(STATUS_GLYPH_PREFIX, "").trim();
	const host = row.hostShort.trim();
	if (title && title !== host) return title;
	return row.name.trim();
}

/**
 * The agent's "home" window: where the agent pane the user last focused lives,
 * else the first window holding any agent pane, else none.
 */
export function homeWindowId(agentPanes: readonly AgentPaneRow[], lastAgentPaneId: string | null): string | null {
	const agents = agentPanes.filter((p) => p.agent);
	const last = lastAgentPaneId ? agents.find((p) => p.paneId === lastAgentPaneId) : undefined;
	return (last ?? agents[0])?.windowId ?? null;
}

export function buildWindowEntries(
	rows: readonly WindowRow[],
	agentPanes: readonly AgentPaneRow[],
	lastAgentPaneId: string | null,
): TmuxWindowEntry[] {
	const home = homeWindowId(agentPanes, lastAgentPaneId);
	return rows.map((row) => ({
		windowId: row.windowId,
		index: row.index,
		label: windowLabel(row),
		...(row.customName.trim() ? { customName: row.customName.trim() } : {}),
		active: row.active,
		home: row.windowId === home,
		panes: row.panes,
		activity: row.activity,
		bell: row.bell,
	}));
}
