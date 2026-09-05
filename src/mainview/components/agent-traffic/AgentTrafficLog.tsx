import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getTaskOverview } from "../../../shared/types";
import { markTrafficSeen } from "../../agent-traffic";
import { useLocale, useT, type TranslationKey } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { useFocusTrap } from "../../utils/useFocusTrap";
import { getStatusLabel } from "../../utils/statusLabel";
import BottomSheet from "../BottomSheet";
import Select from "../Select";
import { AgentTrafficIcon } from "../HeaderIcons";
import { CAROUSEL_MAX_WIDTH } from "../MobileBoardCarousel";
import TrafficOrbit from "./TrafficOrbit";
import { useTrafficData } from "./useTrafficData";
import {
	endpointKey,
	trafficNodes,
	trafficRecords,
	nodeSeq,
	fromKey,
	toKey,
	routeKey,
	type TrafficRecord,
} from "./traffic-model";
import "./traffic-orbit.css";

interface Props {
	projectId: string | null;
	onClose: () => void;
	onOpenTask: (taskId: string, projectId: string) => void;
}
const runtimeKeys = {
	idle: "traffic.orbit.runtimeIdle",
	preparing: "traffic.orbit.runtimePreparing",
	running: "traffic.orbit.runtimeRunning",
	"tearing-down": "traffic.orbit.runtimeTearingDown",
} as const;
const verdictKey = (status: string): TranslationKey => {
	switch (status) {
		case "delivered":
			return "traffic.orbit.delivered";
		case "held":
			return "traffic.orbit.held";
		case "unconfirmed":
			return "traffic.orbit.unconfirmed";
		case "not-delivered":
			return "traffic.orbit.notDelivered";
		default:
			return "traffic.orbit.unknownDelivery";
	}
};

export default function AgentTrafficLog(props: Props) {
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const t = useT();
	const body = <TrafficView {...props} />;
	return narrow ? (
		<BottomSheet
			open
			onClose={props.onClose}
			title={t("traffic.label")}
			testId="agent-traffic-log-sheet"
		>
			<div className="traffic-sheet">{body}</div>
		</BottomSheet>
	) : (
		createPortal(
			<TrafficDialog onClose={props.onClose}>{body}</TrafficDialog>,
			document.body,
		)
	);
}

function TrafficDialog({
	children,
	onClose,
}: {
	children: React.ReactNode;
	onClose: () => void;
}) {
	const t = useT();
	const ref = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);
	return (
		<div
			className="traffic-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={ref}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label={t("traffic.label")}
				className="traffic-dialog"
				data-testid="agent-traffic-log-dialog"
			>
				{children}
			</div>
		</div>
	);
}

function TrafficView({ projectId, onClose, onOpenTask }: Props) {
	const t = useT();
	const [locale] = useLocale();
	const data = useTrafficData();
	const [scope, setScope] = useState(projectId ?? "all");
	const [selected, setSelected] = useState<string | null>(null);
	const [recordKey, setRecordKey] = useState<string | null>(null);
	const [pair, setPair] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	const [windowSize, setWindowSize] = useState("day");
	const [until, setUntil] = useState<number | null>(null);
	const [paused, setPaused] = useState(false);
	const [tab, setTab] = useState("messages");
	const now = Date.now();
	const start =
		windowSize === "hour"
			? now - 3600000
			: windowSize === "day"
				? now - 86400000
				: 0;
	const scopedRows = useMemo(
		() =>
			data.rows.filter(
				(row) =>
					scope === "all" ||
					row.toProjectId === scope ||
					row.fromProjectId === scope,
			),
		[data.rows, scope],
	);
	const records = useMemo(() => trafficRecords(scopedRows), [scopedRows]);
	const scopedTasks = useMemo(
		() =>
			data.tasks.filter(
				(task) =>
					(scope === "all" || task.projectId === scope) &&
					task.status !== "completed" &&
					task.status !== "cancelled",
			),
		[data.tasks, scope],
	);
	const allNodes = useMemo(
		() => trafficNodes(data.tasks, scopedRows),
		[data.tasks, scopedRows],
	);
	const nodeMap = useMemo(
		() => new Map(allNodes.map((node) => [node.key, node])),
		[allNodes],
	);
	const timeRows = useMemo(
		() =>
			records.filter(
				({ row }) =>
					Date.parse(row.at) >= start &&
					Date.parse(row.at) <= (until ?? Infinity),
			),
		[records, start, until],
	);
	const visible = useMemo(
		() =>
			timeRows.filter(({ row }) => {
				if (filter !== "all" && row.status !== filter) return false;
				if (pair && routeKey(row) !== pair) return false;
				if (selected && fromKey(row) !== selected && toKey(row) !== selected)
					return false;
				return `${row.subject ?? ""} ${row.body} ${row.fromSeq} ${row.toSeq} ${row.fromTitle ?? ""} ${row.toTitle ?? ""}`
					.toLocaleLowerCase()
					.includes(query.toLocaleLowerCase());
			}),
		[timeRows, filter, pair, selected, query],
	);
	const nodes = useMemo(() => {
		const endpoints = new Set(
			timeRows.flatMap(({ row }) => [fromKey(row), toKey(row)]),
		);
		return allNodes.filter(
			(node) =>
				(scope === "all" ||
					node.projectId === scope ||
					endpoints.has(node.key)) &&
				(scopedTasks.some(
					(task) => endpointKey(task.projectId, task.id) === node.key,
				) ||
					endpoints.has(node.key)),
		);
	}, [allNodes, timeRows, scope, scopedTasks]);
	const selectedNode = selected ? nodeMap.get(selected) : undefined;
	const record = records.find((record) => record.key === recordKey);
	const taskList = nodes
		.filter((node) =>
			`${nodeSeq(node)} ${node.title}`
				.toLocaleLowerCase()
				.includes(query.toLocaleLowerCase()),
		)
		.sort(
			(a, b) =>
				Number(b.task?.taskType === "coordinator") -
					Number(a.task?.taskType === "coordinator") ||
				(b.seq ?? 0) - (a.seq ?? 0),
		);
	const oldest = Math.max(
		start,
		records.length
			? Date.parse(records[records.length - 1].row.at)
			: now - 3600000,
	);
	const format = (at: string | number) =>
		new Date(at).toLocaleString(locale, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	useEffect(() => {
		markTrafficSeen();
	}, []);
	function select(key: string) {
		setSelected(key);
		setRecordKey(null);
		setPair(null);
	}
	function clearSelection() {
		setSelected(null);
		setRecordKey(null);
		setPair(null);
	}
	function rowButton(item: TrafficRecord) {
		const row = item.row;
		return (
			<button
				key={item.key}
				className={`traffic-message ${recordKey === item.key ? "is-selected" : ""}`}
				onClick={() => setRecordKey(item.key)}
				data-testid="traffic-message-row"
			>
				<span className="traffic-message-meta">
					<b>
						{row.fromSeq === null ? "—" : `#${row.fromSeq}`} → #{row.toSeq}
					</b>
					<time dateTime={row.at}>{format(row.at)}</time>
				</span>
				<strong className="streamer-private">
					{row.subject || row.body.slice(0, 100)}
				</strong>
				<span className={`traffic-verdict verdict-${row.status}`}>
					{t(verdictKey(row.status))}
				</span>
			</button>
		);
	}
	return (
		<div className="traffic-view" data-help-id="traffic.log">
			<span className="sr-only" role="status">
				{t.plural("traffic.orbit.messageCount", visible.length)}
			</span>
			<header className="traffic-header">
				<AgentTrafficIcon className="w-5 h-5 text-agent" />
				<h2>{t("traffic.label")}</h2>
				<span className="traffic-orbit-name">{t("traffic.orbit.name")}</span>
				<div className="traffic-header-tail">
					<span className="traffic-live" role="status">
						{data.loading
							? t("traffic.loading")
							: until === null
								? t("traffic.orbit.live")
								: t("traffic.orbit.history")}
					</span>
					<button
						onClick={() => setPaused((value) => !value)}
						aria-pressed={paused}
					>
						{t(paused ? "traffic.orbit.resume" : "traffic.orbit.pause")}
					</button>
					<button
						onClick={onClose}
						aria-label={t("common.close")}
						title={t("common.close")}
					>
						×
					</button>
				</div>
			</header>
			<div className="traffic-toolbar">
				<Select
					value={scope}
					onChange={(value) => {
						setScope(value);
						clearSelection();
					}}
					options={[
						{ value: "all", label: t("traffic.orbit.allProjects") },
						...data.projects.map((project) => ({
							value: project.id,
							label: project.name,
						})),
					]}
					ariaLabel={t("traffic.orbit.project")}
				/>
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("traffic.orbit.search")}
					aria-label={t("traffic.orbit.search")}
				/>
				<Select
					value={filter}
					onChange={setFilter}
					options={[
						{ value: "all", label: t("traffic.filter.all") },
						...["delivered", "held", "unconfirmed", "not-delivered"].map(
							(value) => ({ value, label: t(verdictKey(value)) }),
						),
					]}
					ariaLabel={t("traffic.orbit.delivery")}
				/>
			</div>
			<div className="traffic-summary">
				<div>
					<strong>
						{data.projects.find((project) => project.id === scope)?.name ??
							t("traffic.orbit.allProjects")}
					</strong>
					<p>{t("traffic.orbit.currentTasks")}</p>
				</div>
				<div className="traffic-stat">
					<b>
						{
							nodes.filter((node) => node.task?.taskType === "coordinator")
								.length
						}
					</b>
					{t("traffic.orbit.coordinators")}
				</div>
				<div className="traffic-stat">
					<b>{scopedTasks.length}</b>
					{t("traffic.orbit.tasks")}
				</div>
				<div className="traffic-stat">
					<b>{timeRows.length}</b>
					{t("traffic.orbit.attempts")}
				</div>
			</div>
			{data.error && (
				<div className="traffic-error" role="alert">
					{t("traffic.orbit.loadError")}{" "}
					<button onClick={data.reload}>{t("traffic.orbit.retry")}</button>
				</div>
			)}
			<div className="traffic-content">
				<div className="traffic-main">
					<TrafficOrbit
						projects={data.projects}
						scope={scope}
						nodes={nodes}
						records={visible}
						selected={selected}
						onSelect={select}
						paused={paused || until !== null}
						ready={!data.loading}
					/>
					<div className="traffic-timeline">
						<div className="traffic-timeline-header">
							<strong>
								{until === null ? t("traffic.orbit.live") : format(until)}
							</strong>
							<span>{t("traffic.orbit.messageTimeline")}</span>
							<Select
								value={windowSize}
								onChange={(value) => {
									setWindowSize(value);
									setUntil(null);
								}}
								options={[
									{ value: "hour", label: t("traffic.orbit.hour") },
									{ value: "day", label: t("traffic.orbit.day") },
									{ value: "all", label: t("traffic.orbit.loadedHistory") },
								]}
								ariaLabel={t("traffic.orbit.timeWindow")}
							/>
							<button onClick={() => setUntil(null)}>
								{t("traffic.orbit.now")}
							</button>
						</div>
						<div className="traffic-ticks" aria-hidden="true">
							{records
								.filter((item) => Date.parse(item.row.at) >= oldest)
								.map((item) => (
									<i
										key={item.key}
										style={{
											left: `${Math.max(0, Math.min(100, ((Date.parse(item.row.at) - oldest) / Math.max(1, now - oldest)) * 100))}%`,
										}}
									/>
								))}
						</div>
						<input
							type="range"
							min={oldest}
							max={now}
							value={until ?? now}
							onChange={(event) => setUntil(Number(event.target.value))}
							aria-label={t("traffic.orbit.messageTimeline")}
							aria-valuetext={
								until === null ? t("traffic.orbit.live") : format(until)
							}
						/>
						<div className="traffic-time-labels">
							<span>{format(oldest)}</span>
							<span>{t("traffic.orbit.currentTasks")}</span>
							<span>{format(now)}</span>
						</div>
					</div>
				</div>
				<aside
					className="traffic-inspector"
					aria-label={t("traffic.orbit.inspector")}
				>
					{record ? (
						<>
							<div className="traffic-inspector-heading">
								<h3>{t("traffic.orbit.message")}</h3>
								<button onClick={() => setRecordKey(null)}>
									{t("traffic.orbit.back")}
								</button>
							</div>
							<div className="traffic-detail">
								<b>
									{record.row.fromSeq === null ? "—" : `#${record.row.fromSeq}`}{" "}
									→ #{record.row.toSeq}
								</b>
								<h3 className="streamer-private">
									{record.row.subject || t("traffic.orbit.noSubject")}
								</h3>
								<p className="streamer-private">
									{[record.row.fromTitle, record.row.toTitle]
										.filter(Boolean)
										.join(" → ")}
								</p>
								<time>{format(record.row.at)}</time>
								{record.row.kind === "scheduled" && (
									<p>
										{t("traffic.scheduled")}
										{record.row.scheduledFor
											? ` · ${format(record.row.scheduledFor)}`
											: ""}
									</p>
								)}
								<p className={`traffic-verdict verdict-${record.row.status}`}>
									{t(verdictKey(record.row.status))}
								</p>
								<p>
									{t(
										record.row.status === "held"
											? "traffic.orbit.heldExplanation"
											: record.row.status === "delivered"
												? "traffic.orbit.deliveredExplanation"
												: record.row.status === "unconfirmed"
													? "traffic.status.unconfirmed"
													: record.row.status === "not-delivered"
														? "traffic.status.notDelivered"
														: "traffic.orbit.unknownDelivery",
									)}
								</p>
								{record.row.reason && (
									<p className="streamer-private">{record.row.reason}</p>
								)}
								{record.row.detail && (
									<p className="streamer-private">{record.row.detail}</p>
								)}
								{record.row.bodyKind === "spill-pointer" && (
									<p>{t("traffic.spilled")}</p>
								)}
								<pre className="traffic-body streamer-private">
									{record.row.body}
								</pre>
								{record.row.spillPath && (
									<code className="streamer-private">
										{record.row.spillPath}
									</code>
								)}
								<div className="traffic-detail-actions">
									<button
										onClick={() => {
											setPair(routeKey(record.row));
											setRecordKey(null);
											setSelected(null);
										}}
									>
										{t("traffic.orbit.showPair")}
									</button>
									{nodeMap.get(toKey(record.row))?.task ? (
										<button
											className="traffic-primary"
											onClick={() =>
												onOpenTask(record.row.toTaskId, record.row.toProjectId)
											}
										>
											{t("traffic.orbit.openTask")}
										</button>
									) : (
										<p>{t("traffic.taskGone")}</p>
									)}
								</div>
							</div>
						</>
					) : (
						<>
							{selectedNode && (
								<div className="traffic-detail traffic-task-detail">
									<div className="traffic-inspector-heading">
										<b>{nodeSeq(selectedNode)}</b>
										<button onClick={clearSelection}>
											{t("traffic.orbit.clear")}
										</button>
									</div>
									<h3 className="streamer-private">
										{selectedNode.title || t("traffic.orbit.historical")}
									</h3>
									{selectedNode.task ? (
										<>
											<p>
												{getStatusLabel(
													selectedNode.task.status,
													t,
													data.projects.find(
														(project) => project.id === selectedNode.projectId,
													),
												)}
												{selectedNode.task.taskType === "coordinator"
													? ` · ${t("traffic.orbit.coordinator")}`
													: ""}
											</p>
											{selectedNode.task.runtimeState && (
												<p title={t("traffic.orbit.runtimeHelp")}>
													{t(
														runtimeKeys[selectedNode.task.runtimeState.runtime],
													)}
												</p>
											)}
											{selectedNode.task.hibernated && (
												<p>{t("task.hibernatedBadge")}</p>
											)}
											{selectedNode.task.draft && <p>{t("task.draftBadge")}</p>}
											<p className="streamer-private">
												{getTaskOverview(selectedNode.task) ||
													t("traffic.orbit.noOverview")}
											</p>
											<button
												className="traffic-primary"
												onClick={() =>
													onOpenTask(selectedNode.id, selectedNode.projectId)
												}
											>
												{t("traffic.orbit.openTask")}
											</button>
										</>
									) : (
										<p>{t("traffic.taskGone")}</p>
									)}
								</div>
							)}
							<div className="traffic-inspector-heading">
								<div className="traffic-tabs">
									<button
										aria-pressed={tab === "messages"}
										onClick={() => setTab("messages")}
									>
										{t("traffic.orbit.messages")}
									</button>
									<button
										aria-pressed={tab === "tasks"}
										onClick={() => setTab("tasks")}
									>
										{t("traffic.orbit.tasks")}
									</button>
								</div>
								{pair && (
									<button onClick={clearSelection}>
										{t("traffic.orbit.clear")}
									</button>
								)}
							</div>
							<div className="traffic-list">
								{tab === "messages" ? (
									visible.length ? (
										visible.map(rowButton)
									) : (
										<p className="traffic-empty">
											{data.loading
												? t("traffic.loading")
												: t("traffic.noneMatch")}
										</p>
									)
								) : (
									taskList.map((node) => (
										<button
											key={node.key}
											className={`traffic-task-row ${node.key === selected ? "is-selected" : ""}`}
											onClick={() => select(node.key)}
										>
											<b>{nodeSeq(node)}</b>
											<span className="streamer-private">
												{node.title || t("traffic.orbit.historical")}
											</span>
											<small>
												{node.task?.taskType === "coordinator"
													? t("traffic.orbit.coordinator")
													: node.task
														? getStatusLabel(
																node.task.status,
																t,
																data.projects.find(
																	(project) => project.id === node.projectId,
																),
															)
														: t("traffic.orbit.historical")}
											</small>
										</button>
									))
								)}
							</div>
						</>
					)}
				</aside>
			</div>
			<footer className="traffic-statusbar">
				<span>
					{data.oldestDay
						? t("traffic.retention", {
								days: String(data.retentionDays),
								oldest: data.oldestDay,
							})
						: t("traffic.retentionEmpty", {
								days: String(data.retentionDays),
							})}{" "}
					·{" "}
					{t("traffic.shownCount", {
						shown: String(visible.length),
						total: String(records.length),
					})}
					{data.hasMore ? ` · ${t("traffic.orbit.partial")}` : ""}
				</span>
				{data.hasMore && (
					<button onClick={data.loadMore} disabled={data.loading}>
						{t("traffic.orbit.loadMore")}
					</button>
				)}
				<span>{t("traffic.orbit.edgesHelp")}</span>
			</footer>
		</div>
	);
}
