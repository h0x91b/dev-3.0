import type { MemoryPressure, SystemMemorySnapshot } from "../../shared/types";
import { useT } from "../i18n";
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
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-fg-muted">{children}</div>
	);
}

function Size({ bytes }: { bytes: number }) {
	return <span className="tabular-nums text-fg-2 shrink-0">{formatBytes(bytes)}</span>;
}

export default function MemoryBreakdownPanel({ snapshot, onSelectTask }: MemoryBreakdownPanelProps) {
	const t = useT();
	const pressureClass = PRESSURE_TEXT_CLASS[snapshot.pressure];

	return (
		<div className="flex flex-col text-xs">
			{/* System — free first, because that is the question being asked. */}
			<div className="flex flex-col gap-1 px-3 py-2.5">
				<div className="flex items-baseline justify-between gap-2">
					<SectionLabel>{t("memory.system")}</SectionLabel>
					<span className={`text-[0.625rem] font-medium ${pressureClass}`}>
						{t(`memory.pressure.${snapshot.pressure}` as "memory.pressure.normal")}
					</span>
				</div>
				<div className="text-fg">
					<span className="font-semibold tabular-nums">{formatBytes(snapshot.headroom)}</span>{" "}
					<span className="text-fg-3">{t("memory.free")}</span>
				</div>
				<div className="text-[0.6875rem] text-fg-3 tabular-nums">
					{t("memory.usedOfTotal", { used: formatBytes(snapshot.used), total: formatBytes(snapshot.total) })}
				</div>
				{snapshot.cached > 0 && (
					<div className="text-[0.6875rem] text-fg-muted">
						{t("memory.cached", { size: formatBytes(snapshot.cached) })}
					</div>
				)}
				{snapshot.pressureEstimated && (
					<div className="text-[0.6875rem] text-fg-muted">{t("memory.pressureEstimated")}</div>
				)}
			</div>

			{/* Swap — the reason everything suddenly feels slow. */}
			<div className="flex items-baseline justify-between gap-2 border-t border-edge px-3 py-2">
				<SectionLabel>{t("memory.swap")}</SectionLabel>
				<div className="text-[0.6875rem] text-right">
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
					<div className="text-[0.6875rem] text-fg-muted">{t("memory.noConsumers")}</div>
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
								<span className="truncate text-[0.625rem] text-fg-muted streamer-private">{consumer.path}</span>
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
					<div className="text-[0.625rem] leading-relaxed text-fg-muted">{t("memory.approxNote")}</div>
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
		</div>
	);
}
