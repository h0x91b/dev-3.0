import { useCallback, useEffect, useState } from "react";
import type { MemoryPressure, SystemMemorySnapshot, WorktreeOrphanGroup } from "../../shared/types";
import { confirm } from "../confirm";
import { useT } from "../i18n";
import { api } from "../rpc";
import { toast } from "../toast";
import { formatBytes } from "../utils/formatBytes";

/**
 * The who-took-it breakdown behind the header memory pill. Rendered inside a
 * floating popover on pointer devices and inside a BottomSheet on narrow — the
 * content is identical, only the container differs, so it lives here once.
 *
 * The structure is the whole argument of the feature: the app's own share sits on
 * its own line, next to the agents it launched, next to Docker and Chrome.
 * Nobody has to be told whose memory it is.
 */

export const PRESSURE_TEXT_CLASS: Record<MemoryPressure, string> = {
	// Normal is deliberately neutral, not success-green: green means "Completed"
	// in this app, and a permanently green header pill reads as a claim.
	normal: "text-fg-3",
	warn: "text-warning",
	critical: "text-danger",
};

/**
 * The pill's level bar. Saturated on purpose: the level used to be a 40%-opacity
 * wash of the text colour, which made warn and critical look identical to normal.
 * Accent rather than green at normal, for the same reason the text stays neutral.
 */
export const PRESSURE_BAR_CLASS: Record<MemoryPressure, string> = {
	normal: "bg-accent",
	warn: "bg-warning",
	critical: "bg-danger",
};

interface MemoryBreakdownPanelProps {
	snapshot: SystemMemorySnapshot;
	/** Jump to a heavy task. Closing the overlay is the caller's job. */
	onSelectTask: (taskId: string, projectId: string) => void;
	/**
	 * Dismiss the popover/sheet before a dialog opens over it. A confirm rendered
	 * under a hover-dismissed popover reads as a dialog with no context.
	 */
	onCloseOverlay: () => void;
}

/**
 * Processes still running inside worktrees of tasks that are done — the only
 * memory in this panel the app is *wasting* rather than spending, and therefore
 * the only row that carries an action (PRODUCT_UX_BIBLE §12.6). Conditional by
 * design: with nothing to reclaim the section is absent, not reassuring.
 *
 * The scan is deliberately not part of the memory snapshot: it costs an `lsof`
 * over the whole process table, which has no business in a 10-second poller.
 */
function LeftoverProcessesSection({ onCloseOverlay }: { onCloseOverlay: () => void }) {
	const t = useT();
	const [groups, setGroups] = useState<WorktreeOrphanGroup[] | null>(null);
	const [killing, setKilling] = useState(false);

	useEffect(() => {
		let cancelled = false;
		api.request
			.scanWorktreeOrphans()
			.then((result) => {
				if (!cancelled) setGroups(result);
			})
			.catch(() => {
				// A failed scan stays silent: this section is a bonus, not the panel.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const processCount = groups?.reduce((sum, group) => sum + group.processCount, 0) ?? 0;
	const rss = groups?.reduce((sum, group) => sum + group.rss, 0) ?? 0;
	const pids = groups?.flatMap((group) => group.pids) ?? [];

	const kill = useCallback(async () => {
		onCloseOverlay();
		const confirmed = await confirm({
			title: t("memory.leftoversConfirmTitle"),
			message: t("memory.leftoversConfirmBody", { count: String(processCount), size: formatBytes(rss) }),
			confirmLabel: t("memory.leftoversKill"),
			danger: true,
		});
		if (!confirmed) return;
		setKilling(true);
		try {
			// Kills the PIDs the dialog counted, never a fresh scan's — the number the
			// user agreed to must be the number that dies.
			const result = await api.request.killWorktreeOrphans({ pids });
			setGroups([]);
			toast.success(t.plural("memory.leftoversKilled", result.killed));
			if (result.leftovers > 0) toast.warning(t.plural("memory.leftoversSurvived", result.leftovers));
		} catch (err) {
			toast.error(t("memory.leftoversKillFailed", { error: String(err) }));
		} finally {
			setKilling(false);
		}
	}, [onCloseOverlay, pids, processCount, rss, t]);

	if (!groups || groups.length === 0) return null;

	return (
		<div className="flex flex-col gap-1.5 border-t border-edge px-3 py-2" data-testid="memory-leftovers">
			<div className="flex items-baseline justify-between gap-2">
				<SectionLabel>{t("memory.leftovers")}</SectionLabel>
				<button
					type="button"
					onClick={kill}
					disabled={killing}
					data-testid="memory-leftovers-kill"
					className="shrink-0 rounded-md border border-danger/30 px-2 py-0.5 text-dense font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
				>
					{killing ? t("memory.leftoversKilling") : t("memory.leftoversKill")}
				</button>
			</div>

			<div className="flex items-baseline justify-between gap-2">
				<span className="min-w-0 text-fg">{t.plural("memory.leftoverProcesses", processCount)}</span>
				<Size bytes={rss} />
			</div>

			<ul className="flex flex-col">
				{groups.map((group) => (
					<li key={group.shortId} className="flex items-baseline justify-between gap-2 py-0.5" title={group.command}>
						<span className="min-w-0 truncate text-dense text-fg-2 streamer-private">
							{group.title || group.shortId}
							<span className="ml-1 text-fg-muted tabular-nums">
								{t.plural("memory.processCount", group.processCount)}
							</span>
						</span>
						<span className="shrink-0 text-dense tabular-nums text-fg-muted">{formatBytes(group.rss)}</span>
					</li>
				))}
			</ul>

			<div className="text-dense leading-relaxed text-fg-muted">{t("memory.leftoversNote")}</div>
		</div>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="text-nano font-semibold uppercase tracking-wider text-fg-muted">{children}</div>
	);
}

function Size({ bytes }: { bytes: number }) {
	return <span className="tabular-nums text-fg-2 shrink-0">{formatBytes(bytes)}</span>;
}

export default function MemoryBreakdownPanel({ snapshot, onSelectTask, onCloseOverlay }: MemoryBreakdownPanelProps) {
	const t = useT();
	const pressureClass = PRESSURE_TEXT_CLASS[snapshot.pressure];

	return (
		<div className="flex flex-col text-xs">
			{/* System — free first, because that is the question being asked. */}
			<div className="flex flex-col gap-1 px-3 py-2.5">
				<div className="flex items-baseline justify-between gap-2">
					<SectionLabel>{t("memory.system")}</SectionLabel>
					<span className={`text-dense font-medium ${pressureClass}`}>
						{t(`memory.pressure.${snapshot.pressure}` as "memory.pressure.normal")}
					</span>
				</div>
				<div className="text-fg">
					<span className="font-semibold tabular-nums">{formatBytes(snapshot.headroom)}</span>{" "}
					<span className="text-fg-3">{t("memory.free")}</span>
				</div>
				<div className="text-micro text-fg-3 tabular-nums">
					{t("memory.usedOfTotal", { used: formatBytes(snapshot.used), total: formatBytes(snapshot.total) })}
				</div>
				{snapshot.cached > 0 && (
					<div className="text-micro text-fg-muted">
						{t("memory.cached", { size: formatBytes(snapshot.cached) })}
					</div>
				)}
				{snapshot.pressureEstimated && (
					<div className="text-micro text-fg-muted">{t("memory.pressureEstimated")}</div>
				)}
			</div>

			{/* Swap — the reason everything suddenly feels slow. */}
			<div className="flex items-baseline justify-between gap-2 border-t border-edge px-3 py-2">
				<SectionLabel>{t("memory.swap")}</SectionLabel>
				<div className="text-micro text-right">
					{snapshot.swapTotal === 0 ? (
						<span className="text-fg-muted">{t("memory.swapNone")}</span>
					) : (
						<span className="text-fg-3 tabular-nums">
							{t("memory.swapInUse", {
								used: formatBytes(snapshot.swapUsed),
								total: formatBytes(snapshot.swapTotal),
							})}
						</span>
					)}
					<span className={`ml-1.5 ${snapshot.swapping ? "text-warning" : "text-fg-muted"}`}>
						{snapshot.swapping ? t("memory.swappingNow") : t("memory.swappingNot")}
					</span>
				</div>
			</div>

			{/* Heaviest things that are NOT us. Grouped per application, so eighty
			    browser helpers are one honest row rather than five useless ones. */}
			<div className="flex flex-col gap-1.5 border-t border-edge px-3 py-2">
				<SectionLabel>{t("memory.outsideDev3")}</SectionLabel>
				{snapshot.topConsumers.length === 0 ? (
					<div className="text-micro text-fg-muted">{t("memory.noConsumers")}</div>
				) : (
					<ul className="flex flex-col gap-1.5">
						{snapshot.topConsumers.map((consumer) => (
							<li key={consumer.name} className="flex flex-col gap-0.5" title={consumer.cmdline}>
								<div className="flex items-baseline justify-between gap-2">
									<span className="min-w-0 truncate text-fg streamer-private">
										{consumer.name}
										{consumer.processCount > 1 && (
											<span className="ml-1 text-fg-muted tabular-nums">
												{t.plural("memory.processCount", consumer.processCount)}
											</span>
										)}
									</span>
									<Size bytes={consumer.rss} />
								</div>
								<span className="truncate text-dense text-fg-muted streamer-private">{consumer.path}</span>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Us — stated plainly, and never flattered. */}
			<div className="flex flex-col gap-1.5 border-t border-edge px-3 py-2">
				<SectionLabel>{t("memory.dev3Section")}</SectionLabel>

				<div className="flex items-baseline justify-between gap-2">
					<span className="text-fg">{t("memory.appItself")}</span>
					<Size bytes={snapshot.appRss} />
				</div>

				<div className="flex items-baseline justify-between gap-2">
					<span className="min-w-0 text-fg">
						{t.plural("memory.activeTasks", snapshot.activeTaskCount)}
					</span>
					{snapshot.activeTaskCount > 0 && (
						<span className="shrink-0 tabular-nums text-fg-2">
							~{formatBytes(snapshot.tasksRssApprox)}
						</span>
					)}
				</div>

				{snapshot.activeTaskCount > 0 && (
					<div className="text-dense leading-relaxed text-fg-muted">{t("memory.approxNote")}</div>
				)}

				{snapshot.topTasks.length > 0 && (
					<ul className="mt-0.5 flex flex-col">
						{snapshot.topTasks.map((task) => (
							<li key={task.shortId}>
								<button
									type="button"
									onClick={() => task.taskId && onSelectTask(task.taskId, task.projectId)}
									disabled={!task.taskId || !task.projectId}
									className="flex w-full items-baseline justify-between gap-2 rounded-md px-1.5 py-1 -mx-1.5 text-left hover:bg-elevated-hover disabled:cursor-default disabled:hover:bg-transparent transition-colors"
								>
									<span className="min-w-0 truncate text-fg-2 streamer-private">
										{task.title || task.shortId}
									</span>
									<Size bytes={task.rss} />
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Last, and only when it exists: the memory we are wasting rather than
			    spending, plus the one action this panel is allowed to carry. */}
			<LeftoverProcessesSection onCloseOverlay={onCloseOverlay} />
		</div>
	);
}
