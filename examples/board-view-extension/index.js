// A complete dev3 board-view extension in one prebuilt ESM file — no build step.
// `react` and `cordis` resolve to dev3's own copies (an import map), so they are not bundled.
import { createElement as h, useEffect, useReducer } from "react";

const VIEW_ID = "focus-list:focus";
const OPEN = new Set(["todo", "in-progress", "user-questions", "review-by-ai", "review-by-user"]);

// Inline styles cannot express :hover or :focus-visible, so the view ships its own small stylesheet,
// scoped under one class. dev3's theme tokens are CSS variables holding "r g b", so colours follow
// light and dark themes.
const CSS = `
.focus-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 24px 24px; color: rgb(var(--text-primary)); }
.focus-list-inner { max-width: 64rem; }
.focus-list-head, .focus-list-row {
	display: grid; grid-template-columns: 4.5rem 3rem minmax(0, 1fr); align-items: center; column-gap: 12px;
	padding: 0 12px;
}
.focus-list-head {
	height: 32px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;
	color: rgb(var(--text-muted)); border-bottom: 1px solid rgb(var(--border-default) / 0.6);
}
.focus-list-items { list-style: none; margin: 0; padding: 4px 0 0; }
.focus-list-row {
	width: 100%; min-height: 36px; box-sizing: border-box; border: 0; border-radius: 6px; background: transparent;
	font: inherit; font-size: 13px; text-align: left; color: rgb(var(--text-secondary)); cursor: pointer;
	transition: background-color 150ms ease-out, color 150ms ease-out;
}
.focus-list-items > li:nth-child(even) .focus-list-row { background: rgb(var(--text-primary) / 0.035); }
.focus-list-row:hover { background: rgb(var(--surface-raised)); color: rgb(var(--text-primary)); }
.focus-list-row:focus-visible { outline: 2px solid rgb(var(--accent) / 0.6); outline-offset: -2px; }
.focus-list-seq { color: rgb(var(--text-tertiary)); font-variant-numeric: tabular-nums; }
.focus-list-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.focus-list-priority {
	justify-self: start; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600;
	font-variant-numeric: tabular-nums; color: rgb(var(--text-tertiary)); background: rgb(var(--border-default) / 0.35);
}
.focus-list-priority[data-priority="P0"] { color: rgb(var(--danger)); background: rgb(var(--danger) / 0.14); }
.focus-list-priority[data-priority="P1"] { color: rgb(var(--accent)); background: rgb(var(--accent) / 0.14); }
.focus-list-empty { padding: 48px 24px; text-align: center; color: rgb(var(--text-muted)); font-size: 13px; }
`;

/** Re-render whenever the board changes, and hand back `ctx.board`. */
function useBoard(ctx) {
	const [, bump] = useReducer((n) => n + 1, 0);
	useEffect(() => ctx.on("board/changed", bump), [ctx]);
	return ctx.board;
}

function FocusRow({ board, task }) {
	const priority = task.priority ?? "P3";
	return h(
		"li",
		null,
		h(
			"button",
			{
				type: "button",
				className: "focus-list-row",
				title: task.title,
				onClick: () => board.openTask(task.id),
				onContextMenu: (event) => {
					event.preventDefault();
					board.openContextMenu(task.id, { x: event.clientX, y: event.clientY });
				},
			},
			h("span", { className: "focus-list-seq" }, `#${task.seq}`),
			h("span", { className: "focus-list-priority", "data-priority": priority }, priority),
			h("span", { className: "focus-list-title" }, task.title),
		),
	);
}

function FocusList({ ctx }) {
	const board = useBoard(ctx);
	const tasks = board.tasks().filter((task) => OPEN.has(task.status));
	const byPriority = [...tasks].sort((a, b) => (a.priority ?? "P3").localeCompare(b.priority ?? "P3"));
	return h(
		"div",
		{ className: "focus-list" },
		h("style", null, CSS),
		byPriority.length === 0
			? h("p", { className: "focus-list-empty" }, "Nothing open on this board.")
			: h(
				"div",
				{ className: "focus-list-inner" },
				h(
					"div",
					{ className: "focus-list-head", "aria-hidden": true },
					h("span", null, "#"),
					h("span", null, "Priority"),
					h("span", null, `Open tasks · ${byPriority.length}`),
				),
				h("ol", { className: "focus-list-items" }, byPriority.map((task) => h(FocusRow, { key: task.id, board, task }))),
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
