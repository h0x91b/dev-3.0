// A complete dev3 board-view extension in one prebuilt ESM file — no build step.
// `react` and `cordis` resolve to dev3's own copies (an import map), so they are not bundled.
import { createElement as h, useEffect, useReducer } from "react";

const VIEW_ID = "focus-list:focus";
// dev3's theme tokens are CSS variables holding "r g b", so colours follow light and dark themes.
const FG = "rgb(var(--text-primary))";
const FG_MUTED = "rgb(var(--text-tertiary))";
const EDGE = "rgb(var(--border-default) / 0.5)";
const OPEN = new Set(["todo", "in-progress", "user-questions", "review-by-ai", "review-by-user"]);

/** Re-render whenever the board changes, and hand back `ctx.board`. */
function useBoard(ctx) {
	const [, bump] = useReducer((n) => n + 1, 0);
	useEffect(() => ctx.on("board/changed", bump), [ctx]);
	return ctx.board;
}

function FocusList({ ctx }) {
	const board = useBoard(ctx);
	const tasks = board.tasks().filter((task) => OPEN.has(task.status));
	const byPriority = [...tasks].sort((a, b) => (a.priority ?? "P3").localeCompare(b.priority ?? "P3"));
	if (byPriority.length === 0) {
		return h("p", { style: { padding: "24px", color: FG_MUTED } }, "Nothing open on this board.");
	}
	return h(
		"ol",
		{ style: { margin: 0, padding: "12px 24px", overflowY: "auto", listStyle: "none", color: FG } },
		byPriority.map((task) =>
			h(
				"li",
				{ key: task.id, style: { padding: "6px 0", borderBottom: `1px solid ${EDGE}` } },
				h(
					"button",
					{
						type: "button",
						onClick: () => board.openTask(task.id),
						onContextMenu: (event) => {
							event.preventDefault();
							board.openContextMenu(task.id, { x: event.clientX, y: event.clientY });
						},
						style: { all: "unset", cursor: "pointer", display: "flex", gap: "12px", width: "100%", color: FG },
					},
					h("span", { style: { color: FG_MUTED, minWidth: "3.5em" } }, `#${task.seq}`),
					h("span", { style: { color: FG_MUTED, minWidth: "2em" } }, task.priority ?? "P3"),
					h("span", null, task.title),
				),
			),
		),
	);
}

// The default export is an ordinary Cordis plugin. `inject` makes it wait for a board.
export default {
	name: "focus-list",
	inject: ["board", "boardViews"],
	apply(ctx) {
		ctx.boardViews.register({
			id: VIEW_ID,
			label: "Focus list",
			component: FocusList,
			supportsNarrow: true,
		});
	},
};
