import { useEffect, useMemo, useReducer, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Context } from "cordis";
import { DEFAULT_PRIORITY, STATUS_COLORS, getTaskTitle, type Task } from "../../../shared/types";
import { ATTENTION_VIEW_ID } from "../../../shared/board-view-state";
import { statusKey, useT } from "../../i18n";
import { PRIORITY_STYLES } from "../../components/priorityStyles";
import { taskActivityTime } from "../../components/sortTasks";
import { useBoard } from "../react";
import type { BoardService } from "../board-service";
import { fillBuckets, type AttentionBucket } from "./buckets";
import { useAttentionLayout, useBucketName } from "./hooks";
import { AttentionOptions } from "./AttentionOptions";

/** Re-evaluation cadence: `is:stalled` is time-based, so buckets must move without a board change. */
export const ATTENTION_TICK_MS = 60_000;
const BUCKET_ROW_CAP = 20;

function useTick(ms: number): number {
	const [tick, bump] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		const id = window.setInterval(bump, ms);
		return () => window.clearInterval(id);
	}, [ms]);
	return tick;
}

function timeAgo(ms: number, t: ReturnType<typeof useT>): string {
	if (!ms) return "";
	const mins = Math.floor((Date.now() - ms) / 60_000);
	if (mins < 1) return t("activity.justNow");
	if (mins < 60) return t("activity.minutesAgo", { count: String(mins) });
	const hours = Math.floor(mins / 60);
	if (hours < 24) return t("activity.hoursAgo", { count: String(hours) });
	return t("activity.daysAgo", { count: String(Math.floor(hours / 24)) });
}

function AttentionRow({ task, board, showProject }: { task: Task; board: BoardService; showProject: boolean }) {
	const t = useT();
	const priority = task.priority ?? DEFAULT_PRIORITY;
	const column = task.customColumnId
		? board.columns().find((c) => c.type === "custom" && c.members.some((m) => m.columnId === task.customColumnId))
		: undefined;
	const statusLabel = column?.type === "custom" ? column.col.name : t(statusKey(task.status));
	const statusColor = column?.type === "custom" ? column.col.color : STATUS_COLORS[task.status];
	const projectName = showProject ? board.projects().find((p) => p.id === task.projectId)?.name : undefined;
	const onContextMenu = (e: ReactMouseEvent) => {
		e.preventDefault();
		board.openContextMenu(task.id, { x: e.clientX, y: e.clientY });
	};
	return (
		<li>
			<button
				type="button"
				onClick={() => board.openTask(task.id)}
				onContextMenu={onContextMenu}
				data-testid="attention-row"
				data-task-id={task.id}
				className="w-full min-h-11 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-[background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.99]"
			>
				<span className="text-fg-3 text-xs tabular-nums flex-shrink-0">#{task.seq}</span>
				<span className={`text-dense leading-none font-semibold px-1 py-0.5 rounded flex-shrink-0 ${PRIORITY_STYLES[priority].badge}`}>
					{priority}
				</span>
				<span className="flex-1 min-w-0 truncate text-sm text-fg">{getTaskTitle(task)}</span>
				{projectName && (
					<span className="hidden sm:inline max-w-28 truncate text-micro text-fg-3 bg-fg/10 px-1.5 py-0.5 rounded flex-shrink-0">
						{projectName}
					</span>
				)}
				<span className="flex items-center gap-1 text-micro text-fg-3 flex-shrink-0 max-w-32" title={statusLabel}>
					<span aria-hidden className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor }} />
					<span className="truncate max-sm:sr-only">{statusLabel}</span>
				</span>
				<span className="text-micro text-fg-muted tabular-nums flex-shrink-0 w-14 text-right">
					{timeAgo(taskActivityTime(task), t)}
				</span>
			</button>
		</li>
	);
}

function BucketSection({ bucket, tasks, board, showProject }: { bucket: AttentionBucket; tasks: Task[]; board: BoardService; showProject: boolean }) {
	const t = useT();
	const nameOf = useBucketName();
	const [expanded, setExpanded] = useState(false);
	const shown = expanded ? tasks : tasks.slice(0, BUCKET_ROW_CAP);
	const headingId = `attention-bucket-${bucket.id}`;
	return (
		<section
			aria-labelledby={headingId}
			data-testid="attention-bucket"
			data-bucket-id={bucket.id}
			className="flex flex-col min-w-0 rounded-xl bg-raised shadow-[0_0_0_1px_rgb(var(--border-default)/0.6)] p-2"
		>
			<header className="flex items-center gap-2 px-2.5 pt-1 pb-2">
				<h3 id={headingId} className="text-sm font-semibold text-fg truncate">{nameOf(bucket)}</h3>
				<span className="text-xs text-fg-3 tabular-nums" data-testid="attention-bucket-count">{tasks.length}</span>
				<code className="ml-auto text-micro text-fg-muted truncate max-w-[50%]" title={bucket.query}>{bucket.query}</code>
			</header>
			{tasks.length === 0 ? (
				<p className="px-2.5 pb-2 text-xs text-fg-muted">{t("boardView.attention.empty")}</p>
			) : (
				<ul className="flex flex-col gap-0.5">
					{shown.map((task) => <AttentionRow key={task.id} task={task} board={board} showProject={showProject} />)}
				</ul>
			)}
			{tasks.length > BUCKET_ROW_CAP && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="mt-1 self-start min-h-8 px-2.5 text-xs text-accent hover:text-accent-emphasis rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				>
					{expanded ? t("boardView.attention.showLess") : t.plural("boardView.attention.showMore", tasks.length - BUCKET_ROW_CAP)}
				</button>
			)}
		</section>
	);
}

/** `builtin:attention`: the board as a triage queue of named token-query buckets (D20). */
export function AttentionView(_props: { ctx: Context }) {
	const board = useBoard();
	const tick = useTick(ATTENTION_TICK_MS);
	const [layout] = useAttentionLayout(board);
	const tasks = board.tasks();
	const bucketsKey = JSON.stringify(layout.buckets);
	// `tick` re-runs the matcher, whose `is:stalled` reads the clock.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const filled = useMemo(() => fillBuckets(tasks, layout.buckets, (task, q) => board.matches(task, q)), [tasks, bucketsKey, board, tick]);
	const narrow = board.formFactor === "narrow";
	const showProject = board.scope.kind === "space";
	return (
		<div
			data-testid="attention-view"
			className={narrow
				? "flex flex-col gap-3 px-3 pb-6 pt-2 overflow-y-auto"
				: "grid gap-3 px-6 pb-6 pt-2 overflow-y-auto items-start grid-cols-[repeat(auto-fill,minmax(min(100%,26rem),1fr))]"}
		>
			{filled.map(({ bucket, tasks: bucketTasks }) => (
				<BucketSection key={bucket.id} bucket={bucket} tasks={bucketTasks} board={board} showProject={showProject} />
			))}
		</div>
	);
}

/** Self-contained: everything it creates belongs to its own plugin, so disposing it removes the view. */
export function installAttentionView(ctx: Context): void {
	ctx.plugin({
		name: ATTENTION_VIEW_ID,
		inject: ["board", "boardViews"],
		apply(pluginCtx: Context) {
			pluginCtx.boardViews.register({
				id: ATTENTION_VIEW_ID,
				label: "boardView.attention",
				component: AttentionView,
				supportsNarrow: true,
				Options: AttentionOptions,
			});
		},
	});
}
