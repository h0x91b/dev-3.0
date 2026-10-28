import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { MemoryPressure, SystemLoadSnapshot, WorktreeDiskUsage } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { useHeaderFlyout } from "../hooks/useHeaderFlyout";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";
import HeaderFlyoutPanel from "./HeaderFlyoutPanel";
import { CpuIcon, DiskIcon } from "./HeaderIcons";
import { PRESSURE_BAR_CLASS, PRESSURE_TEXT_CLASS, SectionLabel } from "./MemoryBreakdownPanel";

/**
 * CPU and disk readouts, beside "Memory left".
 *
 * Same two homes as the memory readout (yaml `global_header.ambient_resource_readout`):
 * a labelled row in the header kebab, always there, and a header pill that appears
 * only while that resource is at warn or critical. Levels come from Settings →
 * System; the backend classifies, so every renderer agrees. Breakdowns are
 * read-only — hover dwell on desktop, BottomSheet on narrow.
 */

const POPOVER_WIDTH = 22 * 16;
/** How many worktrees the disk panel lists before the total line. */
const TOP_WORKTREES = 8;

const percent = (value: number) => `${Math.round(value)}%`;

/** Disk figures in decimal GB/TB, so they match Finder and the vendor's label. */
function formatDiskBytes(bytes: number): string {
	const gb = bytes / 1e9;
	if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
	if (gb >= 10) return `${Math.round(gb)} GB`;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
}

type Variant = "menu" | "bar";

export default function SystemLoadRows({
	navigate,
	variant = "menu",
}: {
	navigate: (route: Route) => void;
	/** `menu`: kebab rows, always shown. `bar`: header pills, only at warn/critical. */
	variant?: Variant;
}) {
	const t = useT();
	const [snapshot, setSnapshot] = useState<SystemLoadSnapshot | null>(null);

	useEffect(() => {
		let cancelled = false;
		api.request
			.getSystemLoad()
			.then((result) => {
				if (!cancelled) setSnapshot(result);
			})
			.catch(() => {
				// First poll pending — the rows stay hidden until the push lands.
			});
		function onUpdate(e: Event) {
			setSnapshot((e as CustomEvent).detail as SystemLoadSnapshot);
		}
		window.addEventListener("rpc:systemLoadUpdated", onUpdate);
		return () => {
			cancelled = true;
			window.removeEventListener("rpc:systemLoadUpdated", onUpdate);
		};
	}, []);

	if (!snapshot) return null;
	const { disk } = snapshot;

	const showCpu = variant === "menu" || snapshot.cpuPressure !== "normal";
	const showDisk = disk && disk.total > 0 && (variant === "menu" || disk.pressure !== "normal");
	const suffix = variant === "bar" ? "pill" : "row";

	return (
		<>
			{showCpu && (
				<ResourceRow
					variant={variant}
					label={t("systemLoad.cpu")}
					icon={<CpuIcon className="size-3 shrink-0" />}
					value={percent(snapshot.cpuLoadPercent)}
					ratio={snapshot.cpuLoadPercent / 100}
					pressure={snapshot.cpuPressure}
					ariaLabel={t("systemLoad.cpuAria", { busy: percent(snapshot.cpuLoadPercent) })}
					testId={`cpu-load-${suffix}`}
				>
					{(close) => <CpuPanel snapshot={snapshot} navigate={navigate} close={close} />}
				</ResourceRow>
			)}
			{showDisk && (
				<ResourceRow
					variant={variant}
					label={t("systemLoad.disk")}
					icon={<DiskIcon className="size-3 shrink-0" />}
					value={formatDiskBytes(disk.free)}
					ratio={1 - disk.free / disk.total}
					pressure={disk.pressure}
					ariaLabel={t("systemLoad.diskAria", { free: formatDiskBytes(disk.free) })}
					testId={`disk-space-${suffix}`}
				>
					{(close) => <DiskPanel disk={disk} navigate={navigate} close={close} />}
				</ResourceRow>
			)}
		</>
	);
}

function ResourceRow({
	variant,
	label,
	icon,
	value,
	ratio,
	pressure,
	ariaLabel,
	testId,
	children,
}: {
	variant: Variant;
	label: string;
	icon: ReactNode;
	value: string;
	ratio: number;
	pressure: MemoryPressure;
	ariaLabel: string;
	testId: string;
	children: (close: () => void) => ReactNode;
}) {
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const flyout = useHeaderFlyout({ variant, isNarrow, repositionKey: value });
	const panel = children(flyout.close);

	const level = (
		<span aria-hidden="true" className="h-0.5 w-full overflow-hidden rounded-full bg-edge">
			<span
				className={`block h-full rounded-full ${PRESSURE_BAR_CLASS[pressure]}`}
				style={{ width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` }}
			/>
		</span>
	);

	return (
		<>
			{variant === "bar" ? (
				// Same pill as the memory readout: icon + number over a level bar.
				<button
					ref={flyout.anchorRef}
					type="button"
					aria-label={ariaLabel}
					data-help-id="header.systemLoad"
					data-testid={testId}
					className={`header-anim flex shrink-0 flex-col justify-center gap-[0.1875rem] rounded-lg px-1.5 py-1 transition-colors hover:bg-elevated ${PRESSURE_TEXT_CLASS[pressure]}`}
					{...flyout.triggerProps}
				>
					<span className="flex items-center gap-1 text-micro font-medium leading-none tabular-nums">
						{icon}
						{value}
					</span>
					{level}
				</button>
			) : (
				<button
					ref={flyout.anchorRef}
					type="button"
					role="menuitem"
					aria-label={ariaLabel}
					data-testid={testId}
					className={`header-anim w-full px-3 py-2 flex items-center gap-2.5 text-fg-2 hover:bg-overlay-hover hover:text-fg transition-colors ${
						isNarrow ? "min-h-11" : ""
					}`}
					{...flyout.triggerProps}
				>
					<span className="flex w-[1.125rem] justify-center [&>svg]:size-[1.125rem]">{icon}</span>
					<span className="text-sm flex-1 text-left">{label}</span>
					<span className={`text-micro font-medium tabular-nums ${PRESSURE_TEXT_CLASS[pressure]}`}>{value}</span>
				</button>
			)}
			{isNarrow ? (
				<BottomSheet open={flyout.open} onClose={flyout.close} title={label} testId={`${testId}-sheet`}>
					{panel}
				</BottomSheet>
			) : (
				flyout.open && (
					<HeaderFlyoutPanel flyout={flyout} width={POPOVER_WIDTH} ariaLabel={label} testId={`${testId}-popover`}>
						{panel}
					</HeaderFlyoutPanel>
				)
			)}
		</>
	);
}

function TaskRow({ title, value, onClick }: { title: string; value: string; onClick?: () => void }) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				disabled={!onClick}
				className="flex w-full items-baseline justify-between gap-2 rounded-md px-1.5 py-1 -mx-1.5 text-left hover:bg-overlay-hover disabled:cursor-default disabled:hover:bg-transparent transition-colors"
			>
				<span className="min-w-0 truncate text-fg-2 streamer-private">{title}</span>
				<span className="shrink-0 tabular-nums text-fg-2">{value}</span>
			</button>
		</li>
	);
}

function LevelHeader({
	pressure,
	headingKey,
	levelKey,
}: {
	pressure: MemoryPressure;
	headingKey: "systemLoad.cpuHeading" | "systemLoad.diskHeading";
	levelKey: "systemLoad.cpuLevel" | "systemLoad.diskLevel";
}) {
	const t = useT();
	return (
		<div className="flex items-baseline justify-between gap-2">
			<SectionLabel>{t(headingKey)}</SectionLabel>
			<span className={`text-dense font-medium ${PRESSURE_TEXT_CLASS[pressure]}`}>
				{t(`${levelKey}.${pressure}` as "systemLoad.cpuLevel.normal")}
			</span>
		</div>
	);
}

interface PanelProps {
	navigate: (route: Route) => void;
	close: () => void;
}

function useOpenTask({ navigate, close }: PanelProps) {
	return useCallback(
		(taskId: string | null, projectId: string) => {
			if (!taskId || !projectId) return undefined;
			return () => {
				close();
				navigate({ screen: "project", projectId, activeTaskId: taskId });
			};
		},
		[close, navigate],
	);
}

function CpuPanel({ snapshot, ...props }: PanelProps & { snapshot: SystemLoadSnapshot }) {
	const t = useT();
	const openTask = useOpenTask(props);
	const hasLoadAvg = snapshot.loadAvg.some((n) => n > 0);

	return (
		<div className="flex flex-col text-xs">
			<div className="flex flex-col gap-1 px-3 py-2.5">
				<LevelHeader pressure={snapshot.cpuPressure} headingKey="systemLoad.cpuHeading" levelKey="systemLoad.cpuLevel" />
				<div className="text-fg">
					<span className="font-semibold tabular-nums">{percent(snapshot.cpuLoadPercent)}</span>{" "}
					<span className="text-fg-3">{t("systemLoad.load")}</span>
				</div>
				<div className="text-micro text-fg-3 tabular-nums">
					{t("systemLoad.cores", { cores: String(snapshot.cores) })}
					{` · ${t("systemLoad.busyPercent", { busy: percent(snapshot.cpuBusy * 100) })}`}
					{hasLoadAvg && ` · ${t("systemLoad.loadAvg", { load: snapshot.loadAvg.map((n) => n.toFixed(2)).join(" ") })}`}
				</div>
			</div>

			<div className="flex flex-col gap-1.5 border-t border-edge px-3 py-2">
				<SectionLabel>{t("systemLoad.outsideDev3")}</SectionLabel>
				{snapshot.topCpuConsumers.length === 0 ? (
					<div className="text-micro text-fg-muted">{t("systemLoad.nothingBusy")}</div>
				) : (
					<ul className="flex flex-col gap-1">
						{snapshot.topCpuConsumers.map((consumer) => (
							<li key={consumer.name} className="flex items-baseline justify-between gap-2" title={consumer.cmdline}>
								<span className="min-w-0 truncate text-fg streamer-private">
									{consumer.name}
									{consumer.processCount > 1 && (
										<span className="ml-1 text-fg-muted tabular-nums">
											{t.plural("memory.processCount", consumer.processCount)}
										</span>
									)}
								</span>
								<span className="shrink-0 tabular-nums text-fg-2">{percent(consumer.cpu)}</span>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="flex flex-col gap-1.5 border-t border-edge px-3 py-2">
				<SectionLabel>{t("memory.dev3Section")}</SectionLabel>
				<div className="flex items-baseline justify-between gap-2">
					<span className="text-fg">{t("memory.appItself")}</span>
					<span className="shrink-0 tabular-nums text-fg-2">{percent(snapshot.appCpu)}</span>
				</div>
				{snapshot.topCpuTasks.length > 0 && (
					<ul className="flex flex-col">
						{snapshot.topCpuTasks.map((task) => (
							<TaskRow
								key={task.shortId}
								title={task.title || task.shortId}
								value={percent(task.cpu)}
								onClick={openTask(task.taskId, task.projectId)}
							/>
						))}
					</ul>
				)}
				<div className="text-dense leading-relaxed text-fg-muted">{t("systemLoad.coreNote")}</div>
			</div>
		</div>
	);
}

/**
 * Worktree sizes are scanned when this panel mounts, never in the poller: `du`
 * walks every file of every worktree, node_modules included.
 */
function DiskPanel({ disk, ...props }: PanelProps & { disk: NonNullable<SystemLoadSnapshot["disk"]> }) {
	const t = useT();
	const openTask = useOpenTask(props);
	const [worktrees, setWorktrees] = useState<WorktreeDiskUsage[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		api.request
			.scanWorktreeDiskUsage()
			.then((result) => {
				if (!cancelled) setWorktrees(result);
			})
			.catch(() => {
				if (!cancelled) setWorktrees([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const totalBytes = worktrees?.reduce((sum, w) => sum + w.bytes, 0) ?? 0;

	return (
		<div className="flex flex-col text-xs">
			<div className="flex flex-col gap-1 px-3 py-2.5">
				<LevelHeader pressure={disk.pressure} headingKey="systemLoad.diskHeading" levelKey="systemLoad.diskLevel" />
				<div className="text-fg">
					<span className="font-semibold tabular-nums">{formatDiskBytes(disk.free)}</span>{" "}
					<span className="text-fg-3">{t("memory.free")}</span>
				</div>
				<div className="text-micro text-fg-3 tabular-nums">
					{t("systemLoad.diskUsedPercent", { percent: percent(Math.floor(((disk.total - disk.free) / disk.total) * 100)), total: formatDiskBytes(disk.total) })}
				</div>
				<div className="text-micro text-fg-muted">{t("systemLoad.diskVolume")}</div>
			</div>

			<div className="flex flex-col gap-1.5 border-t border-edge px-3 py-2" data-testid="disk-worktrees">
				<SectionLabel>{t("systemLoad.worktrees")}</SectionLabel>
				{worktrees === null ? (
					<div className="text-micro text-fg-muted">{t("systemLoad.worktreesScanning")}</div>
				) : worktrees.length === 0 ? (
					<div className="text-micro text-fg-muted">{t("systemLoad.worktreesNone")}</div>
				) : (
					<>
						<div className="flex items-baseline justify-between gap-2">
							<span className="text-fg">{t.plural("systemLoad.worktreesTotal", worktrees.length)}</span>
							<span className="shrink-0 tabular-nums text-fg-2">{formatDiskBytes(totalBytes)}</span>
						</div>
						<ul className="flex flex-col">
							{worktrees.slice(0, TOP_WORKTREES).map((w) => (
								<TaskRow
									key={w.taskId}
									title={w.title || w.shortId}
									value={formatDiskBytes(w.bytes)}
									onClick={openTask(w.taskId, w.projectId)}
								/>
							))}
						</ul>
					</>
				)}
			</div>
		</div>
	);
}
