import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Context } from "cordis";
import type { Project, Task } from "../../../shared/types";
import { getTaskTitle, taskSeqLabel } from "../../../shared/types";
import { useT } from "../../i18n";
import PriorityBadge from "../../components/PriorityBadge";
import { useStatusColors } from "../../hooks/useStatusColors";
import { getStatusLabel } from "../../utils/statusLabel";
import { compactAge } from "../../utils/statusAge";
import { taskLastActivityMs } from "../../utils/projectActivity";
import { useBoard } from "../react";
import type { BoardService } from "../board-service";
import {
	buildTaskTree,
	flattenTree,
	isStandalone,
	normalizeTreeLayout,
	toggleExpanded,
	type TreeLayout,
	type TreeNode,
	type TreeRow,
} from "./tree-model";

export const TREE_VIEW_ID = "builtin:tree";
const ROW_HEIGHT = 36;
const NARROW_ROW_HEIGHT = 48;
const OVERSCAN = 12;
const EMPTY_KEYS: ReadonlySet<string> = new Set();
const INDENT_REM = 1.25;
/** The narrow outline stops indenting here; deeper rows show their level instead. */
export const NARROW_MAX_INDENT = 3;
/** Wide rows stop indenting here so a pathological chain never pushes titles off screen. */
const WIDE_MAX_INDENT = 10;

/** The Tree's layout for the board on screen, normalised, with a setter that persists it. */
export function useTreeLayout(board: BoardService): [TreeLayout, (next: TreeLayout) => void] {
	const layout = normalizeTreeLayout(board.layout(TREE_VIEW_ID));
	const setLayout = useCallback((next: TreeLayout) => board.setLayout(TREE_VIEW_ID, next), [board]);
	return [layout, setLayout];
}

/** The forest for the board on screen, honouring the lineage-only option. */
export function useTaskForest(board: BoardService, layout: TreeLayout): TreeNode[] {
	// Rebuilt on every render (each one is a `board/changed`): the lineage index has
	// no identity a memo could key on, and one linear pass over the board is cheap.
	const roots = buildTaskTree({ tasks: board.tasks(), scopeTasks: board.scopeTasks(), lineageNode: (id) => board.lineageNode(id) });
	return layout.lineageOnly ? roots.filter((node) => !isStandalone(node)) : roots;
}

/** The row's accessible name: its seq and title, never the chevron's "Expand". */
function rowLabel(node: TreeNode, hiddenTitle: string): string {
	if (node.kind === "ghost") return `#${node.ref.seq} ${node.ref.title ?? hiddenTitle} · ${node.ref.projectName}`;
	const lead = node.tasks[0];
	return `#${node.tasks.length > 1 ? lead.seq : taskSeqLabel(lead)} ${getTaskTitle(lead)}`;
}

function Chevron({ open }: { open: boolean }) {
	return (
		<svg aria-hidden className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}

function StatusMark({ task, project, compact }: { task: Task; project: Project | undefined; compact: boolean }) {
	const t = useT();
	const colors = useStatusColors();
	const custom = task.customColumnId ? project?.customColumns?.find((c) => c.id === task.customColumnId) : undefined;
	const label = custom ? custom.name : getStatusLabel(task.status, t, project);
	const color = custom ? custom.color : colors[task.status];
	return (
		<span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2" title={label}>
			<span aria-hidden className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
			{compact ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
		</span>
	);
}

function VariantDots({ tasks }: { tasks: readonly Task[] }) {
	const t = useT();
	const colors = useStatusColors();
	const label = t.plural("boardTree.variants", tasks.length);
	return (
		<span className="flex flex-shrink-0 items-center gap-0.5" title={label} aria-label={label} role="img">
			{tasks.map((variant) => (
				<span key={variant.id} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colors[variant.status] }} />
			))}
		</span>
	);
}

interface RowProps {
	row: TreeRow;
	narrow: boolean;
	projectById: ReadonlyMap<string, Project>;
	showProject: boolean;
	projectName(id: string): string;
	onToggle(row: TreeRow): void;
}

function RowBody({ row, narrow, projectById, showProject, projectName, onToggle }: RowProps) {
	const t = useT();
	const { node } = row;
	const hasChildren = node.children.length > 0;
	const indentLevel = Math.min(row.depth, narrow ? NARROW_MAX_INDENT : WIDE_MAX_INDENT);
	const toggleLabel = t(row.expanded ? "boardTree.collapse" : "boardTree.expand");

	const toggle = hasChildren ? (
		<button
			type="button"
			tabIndex={-1}
			onClick={(e) => {
				e.stopPropagation();
				onToggle(row);
			}}
			aria-label={toggleLabel}
			title={toggleLabel}
			data-testid={`board-tree-toggle-${node.key}`}
			className={`flex flex-shrink-0 items-center justify-center rounded text-fg-3 hover:text-fg motion-safe:active:scale-[0.96] ${narrow ? "h-11 w-9" : "h-6 w-6"}`}
		>
			<Chevron open={row.expanded} />
		</button>
	) : (
		<span aria-hidden className={`flex-shrink-0 ${narrow ? "w-9" : "w-6"}`} />
	);

	const depthMark = narrow && row.depth > NARROW_MAX_INDENT ? (
		<span className="flex-shrink-0 rounded bg-elevated px-1 text-dense tabular-nums text-fg-3" title={t("boardTree.level", { level: row.depth + 1 })}>
			L{row.depth + 1}
		</span>
	) : null;
	const nested = hasChildren && !row.expanded ? (
		<span className="flex-shrink-0 text-xs tabular-nums text-fg-3">{t.plural("boardTree.nested", row.descendantCount)}</span>
	) : null;

	const content = node.kind === "ghost" ? (
		<>
			<span className="flex-shrink-0 text-xs tabular-nums text-fg-3">#{node.ref.seq}</span>
			<span className="min-w-0 flex-1 truncate text-sm italic text-fg-3">
				{node.ref.title ?? t("boardTree.hiddenTitle")}
			</span>
			<span className="flex-shrink-0 truncate rounded border border-dashed border-edge px-1.5 text-xs text-fg-3" title={t("boardTree.otherProject")}>
				{node.ref.projectName}
			</span>
		</>
	) : (
		<TaskContent node={node} narrow={narrow} project={projectById.get(node.tasks[0].projectId)} showProject={showProject} projectName={projectName} />
	);

	return (
		<div
			className={`flex h-full min-w-0 items-center gap-2 ${node.kind === "task" && !node.matches ? "opacity-60" : ""}`}
			style={{ paddingInlineStart: `${indentLevel * INDENT_REM}rem` }}
		>
			{toggle}
			{depthMark}
			{content}
			{nested}
		</div>
	);
}

function TaskContent({ node, narrow, project, showProject, projectName }: {
	node: Extract<TreeNode, { kind: "task" }>;
	narrow: boolean;
	project: Project | undefined;
	showProject: boolean;
	projectName(id: string): string;
}) {
	const lead = node.tasks[0];
	const variants = node.tasks.length > 1;
	const activity = taskLastActivityMs(lead);
	return (
		<>
			<span className="flex-shrink-0 text-xs tabular-nums text-fg-3">#{variants ? lead.seq : taskSeqLabel(lead)}</span>
			<span className="min-w-0 flex-1 truncate text-sm text-fg">{getTaskTitle(lead)}</span>
			{variants && <VariantDots tasks={node.tasks} />}
			{showProject && !narrow && (
				<span className="max-w-[9rem] flex-shrink-0 truncate text-xs text-fg-3">{projectName(lead.projectId)}</span>
			)}
			<span className={narrow ? "flex-shrink-0" : "w-28 flex-shrink-0"}>
				<StatusMark task={lead} project={project} compact={narrow} />
			</span>
			{!narrow && <PriorityBadge priority={lead.priority} />}
			{!narrow && (
				<span className="w-10 flex-shrink-0 text-right text-xs tabular-nums text-fg-3" title={activity ? new Date(activity).toLocaleString() : undefined}>
					{activity ? compactAge(new Date(activity).toISOString()) : ""}
				</span>
			)}
		</>
	);
}

/**
 * `builtin:tree` (spec D19): the board as a lineage forest. A task sits under the
 * task that created it, variants are one node, and a parent on another board is
 * a ghost. Collapsed by default, so a 2400-task board renders its roots only.
 */
export function TreeView(_props: { ctx: Context }) {
	const t = useT();
	const board = useBoard();
	const [layout, setLayout] = useTreeLayout(board);
	const roots = useTaskForest(board, layout);
	const expanded = useMemo(() => new Set(layout.expanded), [layout.expanded]);
	const query = board.query.trim();
	const revealMatches = query !== "";
	// Ancestors a query opened by themselves can still be closed; that choice lasts until the query changes.
	const [queryClosed, setQueryClosed] = useState<{ query: string; keys: ReadonlySet<string> }>({ query, keys: new Set() });
	const closedNow = queryClosed.query === query ? queryClosed.keys : EMPTY_KEYS;
	const rows = flattenTree(roots, expanded, { revealMatches, closed: closedNow });

	const narrow = board.formFactor === "narrow";
	const projects = board.projects();
	const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
	const opsBoardName = t("ops.boardName");
	const projectName = useCallback((id: string) => {
		const project = projectById.get(id);
		return project ? (project.builtin ? opsBoardName : project.name) : "";
	}, [projectById, opsBoardName]);

	const scrollRef = useRef<HTMLDivElement>(null);
	const rowHeight = narrow ? NARROW_ROW_HEIGHT : ROW_HEIGHT;
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => rowHeight,
		overscan: OVERSCAN,
		getItemKey: (index) => rows[index].node.key,
	});
	useEffect(() => {
		virtualizer.measure();
	}, [virtualizer, narrow]);

	const setOpen = (row: TreeRow, open: boolean) => {
		const { node } = row;
		if (node.children.length === 0) return;
		if (revealMatches && !node.matches && !expanded.has(node.key)) {
			const keys = new Set(closedNow);
			if (open) keys.delete(node.key);
			else keys.add(node.key);
			setQueryClosed({ query, keys });
			return;
		}
		setLayout(toggleExpanded(layout, node.key, open));
	};
	const onToggle = (row: TreeRow) => setOpen(row, !row.expanded);

	const focusRow = (index: number) => {
		const target = Math.max(0, Math.min(rows.length - 1, index));
		virtualizer.scrollToIndex(target);
		requestAnimationFrame(() => {
			scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${target}"]`)?.focus();
		});
	};

	const open = (row: TreeRow) => {
		if (row.node.kind === "task") board.openTask(row.node.tasks[0].id);
		else onToggle(row);
	};

	const openMenu = (row: TreeRow, e: MouseEvent) => {
		if (row.node.kind !== "task") return;
		e.preventDefault();
		board.openContextMenu(row.node.tasks[0].id, { x: e.clientX, y: e.clientY });
	};

	const onRowKeyDown = (row: TreeRow, index: number, e: KeyboardEvent<HTMLElement>) => {
		if (e.target !== e.currentTarget) return;
		const hasChildren = row.node.children.length > 0;
		switch (e.key) {
			case "Enter":
				e.preventDefault();
				open(row);
				return;
			case "ArrowDown":
			case "ArrowUp":
				e.preventDefault();
				focusRow(index + (e.key === "ArrowDown" ? 1 : -1));
				return;
			case "Home":
			case "End":
				e.preventDefault();
				focusRow(e.key === "Home" ? 0 : rows.length - 1);
				return;
			case "ArrowRight":
				e.preventDefault();
				if (hasChildren && !row.expanded) setOpen(row, true);
				else if (row.expanded) focusRow(index + 1);
				return;
			case "ArrowLeft":
				e.preventDefault();
				if (row.expanded) setOpen(row, false);
				else if (row.parentIndex >= 0) focusRow(row.parentIndex);
				return;
		}
		if (row.node.kind === "task" && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
			e.preventDefault();
			const rect = e.currentTarget.getBoundingClientRect();
			board.openContextMenu(row.node.tasks[0].id, { x: rect.left + 24, y: rect.bottom });
		}
	};

	if (rows.length === 0) {
		const total = board.scopeTasks().length;
		return (
			<div className="flex flex-1 items-center justify-center px-6 py-16 text-sm text-fg-3" data-testid="board-tree-empty">
				{total === 0 ? t("boardTree.emptyBoard") : t("boardTree.noMatches")}
			</div>
		);
	}

	const showProject = board.scope.kind === "space";
	return (
		<div ref={scrollRef} className={`min-h-0 flex-1 overflow-y-auto pb-6 ${narrow ? "px-3 pt-2" : "px-6"}`} data-testid="board-tree">
			<div role="tree" aria-label={t("boardView.tree")} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((item) => {
					const row = rows[item.index];
					const { node } = row;
					const hasChildren = node.children.length > 0;
					return (
						<div
							key={item.key}
							role="treeitem"
							aria-level={row.depth + 1}
							aria-label={rowLabel(node, t("boardTree.hiddenTitle"))}
							aria-expanded={hasChildren ? row.expanded : undefined}
							aria-selected={false}
							tabIndex={0}
							data-row-index={item.index}
							data-testid={`board-tree-row-${node.key}`}
							data-ghost={node.kind === "ghost" ? "" : undefined}
							onClick={() => open(row)}
							onContextMenu={(e) => openMenu(row, e)}
							onKeyDown={(e) => onRowKeyDown(row, item.index, e)}
							className={`absolute left-0 top-0 w-full cursor-pointer rounded-md px-1 outline-none hover:bg-raised-hover focus-visible:bg-raised-hover focus-visible:shadow-[inset_2px_0_0_rgb(var(--accent))] ${narrow ? "border-b border-edge/50" : ""}`}
							style={{ height: rowHeight, transform: `translateY(${item.start}px)` }}
						>
							<RowBody row={row} narrow={narrow} projectById={projectById} showProject={showProject} projectName={projectName} onToggle={onToggle} />
						</div>
					);
				})}
			</div>
		</div>
	);
}
