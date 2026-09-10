import { useEffect, useMemo, useRef, useState } from "react";
import { getTaskOverview } from "../../../shared/types";
import { markTrafficSeen } from "../../agent-traffic";
import { useLocale, useT, type TranslationKey } from "../../i18n";
import { useGlobalShortcut } from "../../hooks/useGlobalShortcut";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { getOverlayLayerElements } from "../../utils/overlay-layers";
import { isTypingContext } from "../../utils/typing-context";
import { getStatusLabel } from "../../utils/statusLabel";
import BottomSheet from "../BottomSheet";
import Select from "../Select";
import TrafficOrbit from "./TrafficOrbit";
import TrafficNodes from "./TrafficNodes";
import TrafficPlayback from "./TrafficPlayback";
import TrafficPeriodPicker from "./TrafficPeriodPicker";
import { isCalendarDay, trafficPeriodBounds } from "./traffic-period";
import TrafficIcon from "./TrafficIcon";
import { useTrafficPlayback } from "./useTrafficPlayback";
import { useTrafficData } from "./useTrafficData";
import { useTrafficExperiment } from "./useTrafficExperiment";
import type { AgentTrafficExperiment } from "../../../shared/types";
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
import {
	buildTimeline,
	type TrafficTimelineEvent,
} from "./traffic-timeline";
import {
	ACTIVE_PROJECTS,
	ALL_PROJECTS,
	activeProjectIds,
	admits,
	scopeProjectIds,
} from "./traffic-scope";
import "./traffic-orbit.css";
import "./traffic-nodes.css";

interface Props {
	/** The project the user came from; seeds the scope filter, nothing else. */
	projectId: string | null;
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

/**
 * The Agent traffic screen: one routed destination, the same on every width.
 *
 * It used to be a modal dialog (a portal, a focus trap, an Escape-dismiss and a
 * BottomSheet on phones), which cost it the app header, Back/Forward and a screen
 * path in analytics. It is a route now — the shell above it is the ordinary one,
 * so this component owns nothing but its own content.
 */
export default function AgentTrafficScreen(props: Props) {
	return (
		<div className="traffic-screen" data-testid="agent-traffic-screen">
			<div className="traffic-frame">
				<TrafficView {...props} />
			</div>
		</div>
	);
}

/**
 * Which presentation renders the same traffic — the orbit or the node graph.
 *
 * A radiogroup, not two toggles: the two are mutually exclusive views of one
 * data set, exactly like the diff viewer's modes, and it sits in the toolbar
 * with the other view controls rather than in the header. It never touches the
 * feature flag; with the feature off nothing here exists to be clicked.
 */
function ExperimentPicker({
	value,
	onChange,
}: {
	value: AgentTrafficExperiment;
	onChange: (next: AgentTrafficExperiment) => void;
}) {
	const t = useT();
	const options = [
		{
			id: "2",
			label: "traffic.experiment.two",
			hint: "traffic.experiment.twoHint",
		},
		{
			id: "1",
			label: "traffic.experiment.one",
			hint: "traffic.experiment.oneHint",
		},
	] as const satisfies readonly {
		id: AgentTrafficExperiment;
		label: TranslationKey;
		hint: TranslationKey;
	}[];
	return (
		<div
			className="traffic-experiment"
			role="radiogroup"
			aria-label={t("traffic.experiment.label")}
			onKeyDown={(event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const next = value === "1" ? "2" : "1";
				onChange(next);
				event.currentTarget
					.querySelector<HTMLButtonElement>(
						`[data-testid="traffic-experiment-${next}"]`,
					)
					?.focus();
			}}
		>
			{options.map((option) => (
				<button
					key={option.id}
					type="button"
					role="radio"
					aria-checked={value === option.id}
					tabIndex={value === option.id ? 0 : -1}
					title={t(option.hint)}
					data-testid={`traffic-experiment-${option.id}`}
					onClick={() => onChange(option.id)}
				>
					{t(option.label)}
				</button>
			))}
		</div>
	);
}

/**
 * The kinds of event the replay timeline carries.
 *
 * A superset of `TrafficTimelineEventKind`, which the timeline now carries for
 * real: `task` and `message` are events, `notification` is a control value with
 * no arm behind it yet. The two coincide the moment the notification arm lands,
 * and this alias goes away then — the widened kind is why it cannot go away now.
 *
 * The LEVEL axis's VALUES, order and `traffic.notification.level.*` keys belong to
 * Seq 1825 and are deliberately not restated here — but its LAYOUT is this
 * screen's, and it is built: see {@link FilterAxes}, which lays out any number of
 * axes identically. The level axis is one {@link FilterAxis} object away, and that
 * object is assembled from their exports, not from a copy of them.
 */
type TimelineKind = "task" | "message" | "notification";
const ALL_KINDS: readonly TimelineKind[] = ["task", "message", "notification"];

const KIND_LABEL: Record<TimelineKind, TranslationKey> = {
	task: "traffic.kind.task",
	message: "traffic.kind.message",
	notification: "traffic.kind.notification",
};

/**
 * The kinds this window can offer a control over — **never** the kinds currently
 * selected, and never the kinds left visible after filtering.
 *
 * The distinction is the whole safety of the control: derive it from the filtered
 * timeline and a reader who narrows to one kind watches the group collapse to one
 * option, or vanish, taking with it the only way back. Availability is a property
 * of the window; selection is a property of the reader.
 *
 * Takes the window's PRE-filter union and returns the kinds present in it. Never
 * the selection: narrowing must not remove the control that undoes the narrowing.
 */
export function availableKinds(
	timeline: readonly TrafficTimelineEvent[],
): ReadonlySet<TimelineKind> {
	return new Set(timeline.map((event) => event.kind));
}

/**
 * One filter axis, described without naming its vocabulary.
 *
 * `values` and `labelKey` are supplied by whoever owns the axis — the kind axis
 * fills them in from this file, the level axis from Seq 1825's
 * `NOTIFICATION_LEVELS` and `notificationLevelKey`. Nothing about a level is
 * declared here, and the layout does not care which axis it is drawing.
 *
 * `selected` may be null, meaning "everything", so an axis can be laid out before
 * its values are known and a default never has to be spelled out twice.
 */
export interface FilterAxis {
	id: string;
	label: string;
	values: readonly string[];
	labelKey: (value: string) => TranslationKey;
	selected: ReadonlySet<string> | null;
	onChange: (next: ReadonlySet<string>) => void;
}

/**
 * Every filter axis, laid out as one run of groups in the toolbar.
 *
 * An axis appears only when the window can offer more than one of its values:
 * a toggle over a value that cannot occur is a dead control, and a one-option
 * group is noise. Availability is computed pre-filter ({@link availableKinds}),
 * so narrowing the selection never removes the control that would undo it.
 */
export function FilterAxes({ axes }: { axes: readonly FilterAxis[] }) {
	return (
		<>
			{axes
				.filter((axis) => axis.values.length > 1)
				.map((axis) => (
					<FilterToggles
						key={axis.id}
						label={axis.label}
						values={axis.values}
						selected={axis.selected ?? new Set(axis.values)}
						labelKey={axis.labelKey}
						onChange={axis.onChange}
						testIdPrefix={`traffic-${axis.id}`}
					/>
				))}
		</>
	);
}

/**
 * A multi-select row of toggles for one filter axis, shaped like the existing
 * toolbar segments.
 *
 * Never a radiogroup: the axes are independent sets, and turning two kinds off is
 * a normal thing to want. The last enabled value cannot be turned off — an empty
 * axis is "show nothing", which the reader would have to undo by guessing which
 * control did it.
 */
function FilterToggles({
	label,
	values,
	selected,
	labelKey,
	onChange,
	testIdPrefix,
}: {
	label: string;
	values: readonly string[];
	selected: ReadonlySet<string>;
	labelKey: (value: string) => TranslationKey;
	onChange: (next: ReadonlySet<string>) => void;
	testIdPrefix: string;
}) {
	const t = useT();
	return (
		<div className="traffic-toggles" role="group" aria-label={label}>
			{values.map((value) => {
				const on = selected.has(value);
				return (
					<button
						key={value}
						type="button"
						aria-pressed={on}
						disabled={on && selected.size === 1}
						data-testid={`${testIdPrefix}-${value}`}
						onClick={() => {
							const next = new Set(selected);
							if (on) next.delete(value);
							else next.add(value);
							if (next.size) onChange(next);
						}}
					>
						{t(labelKey(value))}
					</button>
				);
			})}
		</div>
	);
}

/**
 * The window a fresh entry to the screen picks, and nothing else.
 *
 * An hour, because the question the screen answers on arrival is "what did my
 * agents just say to each other" — replaying a whole day is minutes of watching
 * before the cursor reaches anything recent. The period picker names it on
 * screen, wider windows are one click away, and a calendar day still loads
 * retained history. `Live` deliberately keeps returning to its own 24 hours:
 * that control is not part of the entry rule.
 */
const ENTRY_WINDOW = "hour";
/** What `Live` returns to — unchanged, and deliberately not {@link ENTRY_WINDOW}. */
const LIVE_WINDOW = "day";

function TrafficView({ projectId, onOpenTask }: Props) {
	const t = useT();
	const [locale] = useLocale();
	const [windowSize, setWindowSize] = useState(ENTRY_WINDOW);
	const now = Date.now();
	const { start, end } = trafficPeriodBounds(windowSize, now);
	const calendarDay = isCalendarDay(windowSize);
	const data = useTrafficData(calendarDay ? start : undefined);
	const { experiment, choose } = useTrafficExperiment();
	// Arriving without a project opens on the active projects, not on all of them:
	// eighteen empty blocks are eighteen blocks of stage the busy two could have
	// had. A project the user came from still wins — an explicit subject beats a
	// default — and the initialiser runs once, so their own later pick survives
	// every re-render and every reload of the window.
	const [scope, setScope] = useState(projectId ?? ACTIVE_PROJECTS);
	const [selected, setSelected] = useState<string | null>(null);
	const [recordKey, setRecordKey] = useState<string | null>(null);
	const [pair, setPair] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	// `delivery` (above) governs messages only and `kinds` governs every event, so
	// a message filter can never silently swallow a notification.
	const [kinds, setKinds] = useState<ReadonlySet<TimelineKind>>(() => new Set(ALL_KINDS));
	const [until, setUntil] = useState<number | null>(null);
	const [paused, setPaused] = useState(false);
	const [tab, setTab] = useState("messages");
	const [showInspector, setShowInspector] = useState(false);
	const narrowControls = useNarrowViewport(900);
	const [showFilters, setShowFilters] = useState(false);
	const [focusRequest, setFocusRequest] = useState(0);
	const [followRequest, setFollowRequest] = useState(0);
	/**
	 * The window's whole recorded union, before any scope or filter runs.
	 *
	 * Deliberately unscoped: it is what decides which projects the `active` scope
	 * admits, and deriving that from scoped data would be circular — a project
	 * filtered out could never prove it belonged. It is also independent of the
	 * replay cursor, so membership holds still while the cursor walks the window
	 * and only moves when the window changes or a live event actually arrives.
	 */
	const windowTimeline = useMemo(
		() =>
			buildTimeline({
				records: trafficRecords(data.rows),
				tasks: data.tasks,
				start,
				end,
			}),
		[data.rows, data.tasks, start, end],
	);
	const scopeProjects = useMemo(
		() =>
			scopeProjectIds({
				scope,
				active: activeProjectIds(windowTimeline),
				settled: !data.loading && !data.historyLoading,
			}),
		[scope, windowTimeline, data.loading, data.historyLoading],
	);
	const scopedRows = useMemo(
		() =>
			data.rows.filter(
				(row) =>
					admits(scopeProjects, row.toProjectId) ||
					admits(scopeProjects, row.fromProjectId),
			),
		[data.rows, scopeProjects],
	);
	const records = useMemo(() => trafficRecords(scopedRows), [scopedRows]);
	const scopedTasks = useMemo(
		() =>
			data.tasks.filter(
				(task) =>
					admits(scopeProjects, task.projectId) &&
					task.status !== "completed" &&
					task.status !== "cancelled",
			),
		[data.tasks, scopeProjects],
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
					Date.parse(row.at) < end &&
					Date.parse(row.at) <=
						(experiment === "1" ? (until ?? Infinity) : Infinity),
			),
		[records, start, end, until, experiment],
	);
	const showMessages = kinds.has("message");
	const scopedAllTasks = useMemo(
		() => data.tasks.filter((task) => admits(scopeProjects, task.projectId)),
		[data.tasks, scopeProjects],
	);
	/**
	 * What the window CAN carry, before any filter runs.
	 *
	 * Availability must never depend on the filter: derive it from the filtered
	 * timeline and turning a kind off removes the very control that turns it back
	 * on, stranding the reader with data they cannot restore.
	 */
	const availableTimeline = useMemo(
		() =>
			buildTimeline({
				records: timeRows,
				tasks: scopedAllTasks,
				start,
				end,
			}),
		[timeRows, scopedAllTasks, start, end],
	);
	const kindsPresent = useMemo(
		() => availableKinds(availableTimeline),
		[availableTimeline],
	);

	const replayRecords = useMemo(
		() =>
			(showMessages ? timeRows : []).filter(
				({ row }) =>
					(filter === "all" || row.status === filter) &&
					(!pair || routeKey(row) === pair) &&
					`${row.subject ?? ""} ${row.body} ${row.fromSeq} ${row.toSeq} ${row.fromTitle ?? ""} ${row.toTitle ?? ""}`
						.toLocaleLowerCase()
						.includes(query.toLocaleLowerCase()),
			),
		[timeRows, showMessages, filter, pair, query],
	);
	// Recorded task movements ride the same timeline as messages, so an hour
	// where the board moved and nobody said anything still has steps to play. The
	// window bounds are applied inside the builder so every arm is clipped by exactly
	// the same interval rather than each caller being trusted to have done it.
	const timeline = useMemo(
		() =>
			buildTimeline({
				records: replayRecords,
				tasks: scopedAllTasks,
				start,
				end,
			}).filter((event) => kinds.has(event.kind)),
		// `delivery: "all"` because `replayRecords` already applied it to the message
		// arm along with pair and query; running it twice would be the same answer.
		[replayRecords, scopedAllTasks, start, end, kinds],
	);
	// A filter hiding everything and an empty window are different answers, and the
	// entry window is one hour — on a quiet morning it is legitimately empty.
	const filtering =
		filter !== "all" ||
		Boolean(pair) ||
		query.trim().length > 0 ||
		kinds.size < ALL_KINDS.length;
	// Every filter input belongs in this key: changing one changes the timeline's
	// length, and a cursor that survives that points at an event which is no longer
	// there. Field order matches the key Seq 1823 assembles at integration.
	const kindKey = [...kinds].sort().join(",");
	const playback = useTrafficPlayback(
		timeline,
		experiment === "2",
		`${scope}:${windowSize}:${filter}:${kindKey}:${pair}:${query}`,
	);
	const graphRecords =
		playback.index < 0
			? replayRecords
			: playback.events
					.slice(0, playback.index + 1)
					.flatMap((event) => (event.kind === "message" ? [event.record] : []));
	const cursorAt = playback.cursor.at;
	const visible = useMemo(
		() =>
			(showMessages ? timeRows : []).filter(({ row }) => {
				if (
					experiment === "2" &&
					cursorAt !== null &&
					Date.parse(row.at) > cursorAt
				)
					return false;
				if (filter !== "all" && row.status !== filter) return false;
				if (pair && routeKey(row) !== pair) return false;
				if (selected && fromKey(row) !== selected && toKey(row) !== selected)
					return false;
				return `${row.subject ?? ""} ${row.body} ${row.fromSeq} ${row.toSeq} ${row.fromTitle ?? ""} ${row.toTitle ?? ""}`
					.toLocaleLowerCase()
					.includes(query.toLocaleLowerCase());
			}),
		[timeRows, showMessages, filter, pair, selected, query, experiment, cursorAt],
	);
	const nodes = useMemo(() => {
		const endpoints = new Set(
			timeRows.flatMap(({ row }) => [fromKey(row), toKey(row)]),
		);
		return allNodes.filter(
			(node) =>
				(admits(scopeProjects, node.projectId) || endpoints.has(node.key)) &&
				(scopedTasks.some(
					(task) => endpointKey(task.projectId, task.id) === node.key,
				) ||
					endpoints.has(node.key)),
		);
	}, [allNodes, timeRows, scopeProjects, scopedTasks]);
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
	// Entry is Live, with the camera following. No cursor is placed and nothing
	// plays on arrival: the screen's first job is to show what is happening now,
	// and an automatic replay of the trailing hour hijacked the stage before the
	// reader had asked for anything. Replay stays fully available — the transport's
	// Play (and Space) start it from the window's beginning on demand.
	// Space toggles the replay, the way it does in a media player — same action as
	// the transport's Play/Pause button, including its restart-when-finished
	// semantics. Hand-written and non-remappable: `Space` is a `RESERVED_CODE` in
	// keymap-bindings because it activates whatever control holds focus, so this
	// fires only when nothing else owns the key. keymap.ts lists it display-only.
	const playPause = useRef(playback.playPause);
	playPause.current = playback.playPause;
	const spaceArmed = experiment === "2" && replayRecords.length > 0;
	useGlobalShortcut(
		(event) => {
			if (!spaceArmed || event.code !== "Space") return;
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
			// A held key must not flip play/pause per repeat, and a composing IME
			// owns the keystroke outright.
			if (event.repeat || event.isComposing || isTypingContext()) return;
			// The focused control activates on Space; an open dropdown or calendar
			// owns the keyboard above the stage.
			const active = document.activeElement as HTMLElement | null;
			if (active?.closest('button,a[href],[role="button"],[role="radio"],[role="option"]')) return;
			if (getOverlayLayerElements().length) return;
			// Stops the page from scrolling under the overlay.
			event.preventDefault();
			event.stopPropagation();
			playPause.current();
		},
		[spaceArmed],
	);
	function select(key: string) {
		setSelected(key);
		setShowInspector(true);
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
				onClick={() => {
					setRecordKey(item.key);
					setShowInspector(true);
				}}
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
	const liveLabel =
		data.loading || data.historyLoading
			? t("traffic.loading")
			: (experiment === "2" ? playback.index < 0 && !calendarDay : until === null)
				? t("traffic.orbit.live")
				: t("traffic.orbit.history");
	const filters = (
		<>
			<Select
				value={scope}
				onChange={(value) => {
					setScope(value);
					clearSelection();
				}}
				options={[
					// The scope the screen opens on leads the list, then the two aggregate
					// scopes stay adjacent above the per-project entries, so the list reads
					// broad → narrow in one gradient.
					{ value: ACTIVE_PROJECTS, label: t("traffic.orbit.activeProjects") },
					{ value: ALL_PROJECTS, label: t("traffic.orbit.allProjects") },
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
		</>
	);
	return (
		<div
			className="traffic-view"
			data-experiment={experiment}
			data-help-id="traffic.log"
		>
			<span className="sr-only" role="status">
				{t.plural("traffic.orbit.messageCount", visible.length)}
			</span>
			<div className="traffic-toolbar">
				{/* One control per axis, in the toolbar the other view controls already
				    live in — never a second filter cluster. It renders only once the
				    timeline can actually carry more than one kind: a toggle over a kind
				    that cannot occur is a dead control, and a one-option group is noise.
				    Seq 1825's level group joins it here on the same terms. */}
				{experiment === "2" && (
					<FilterAxes
						axes={[
							{
								id: "kind",
								label: t("traffic.filter.kinds"),
								values: ALL_KINDS.filter((kind) => kindsPresent.has(kind)),
								labelKey: (value) => KIND_LABEL[value as TimelineKind],
								selected: kinds,
								onChange: (next) => setKinds(next as ReadonlySet<TimelineKind>),
							},
						]}
					/>
				)}
				<ExperimentPicker
					value={experiment}
					onChange={(value) => {
						choose(value);
						if (value === "1" && calendarDay) setWindowSize(LIVE_WINDOW);
					}}
				/>
				{experiment === "2" && narrowControls ? (
					<button onClick={() => setShowFilters(true)}>
						{t("traffic.replay.filters")}
					</button>
				) : (
					filters
				)}
				{experiment === "2" && (
					<button
						className="traffic-list-toggle"
						aria-pressed={showInspector}
						onClick={() => setShowInspector((value) => !value)}
					>
						{t("traffic.orbit.messages")}
					</button>
				)}
				{/* The route's breadcrumb already names this screen, so it owns no title
				    row of its own; the live/history readout and the one stage action ride
				    at the end of the toolbar the other view controls already live in. */}
				<div className="traffic-toolbar-tail">
					<span className="traffic-live" role="status" title={liveLabel}>
						{liveLabel}
					</span>
					{experiment === "2" && (
						<button
							className="traffic-replay-start"
							onClick={() => {
								clearSelection();
								setShowInspector(false);
								setFollowRequest((value) => value + 1);
								playback.restart();
							}}
							disabled={!playback.events.length}
							aria-label={t("traffic.replay.restart")}
						>
							<TrafficIcon name="replay" />
							<span className="traffic-action-label">
								{t("traffic.replay.restart")}
							</span>
						</button>
					)}
					{experiment === "1" && (
						<button
							onClick={() => setPaused((value) => !value)}
							aria-pressed={paused}
						>
							{t(paused ? "traffic.orbit.resume" : "traffic.orbit.pause")}
						</button>
					)}
				</div>
			</div>
			{experiment === "2" && narrowControls && (
				<BottomSheet
					open={showFilters}
					onClose={() => setShowFilters(false)}
					title={t("traffic.replay.filters")}
				>
					<div className="traffic-filter-fields">{filters}</div>
				</BottomSheet>
			)}

			<div className="traffic-summary">
				<div>
					<strong>
						{data.projects.find((project) => project.id === scope)?.name ??
							t(
								scope === ACTIVE_PROJECTS
									? "traffic.orbit.activeProjects"
									: "traffic.orbit.allProjects",
							)}
					</strong>
					{/* Only a live cursor rebuilds anything: Experiment 1 has none at
					    all, and Experiment 2 on Live is showing the board as it is. Both
					    of those really are current, and claiming otherwise would be a lie
					    on screen in the opposite direction. */}
					<p>
						{experiment === "2" && playback.cursor.at !== null
							? t("traffic.replay.reconstructedTasks")
							: t("traffic.orbit.currentTasks")}
					</p>
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
					{/* One stage at a time: switching unmounts the other, so neither
					    presentation can leave a loop or an observer running behind it. */}
					{experiment === "1" ? (
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
					) : (
						<TrafficNodes
							projects={data.projects}
							scope={scope}
							nodes={nodes}
							records={graphRecords}
							layoutRecords={timeRows}
							selected={selected}
							onSelect={select}
							paused={false}
							playback={playback}
							focusRequest={focusRequest}
							followRequest={followRequest}
							ready={!data.loading}
						/>
					)}
					{experiment === "2" ? (
						<TrafficPlayback
							loading={data.loading || data.historyLoading}
							emptyKey={filtering ? "traffic.noneMatch" : "traffic.emptyWindow"}
							playback={playback}
							onInspect={(key) => {
								setRecordKey(key);
								setShowInspector(true);
							}}
							historical={calendarDay}
							onLive={() => {
								setWindowSize(LIVE_WINDOW);
								setFollowRequest((value) => value + 1);
								playback.live();
							}}
							windowControl={
								<TrafficPeriodPicker
									value={windowSize}
									retentionDays={data.retentionDays}
									onChange={(value) => {
										setWindowSize(value);
										clearSelection();
										setFollowRequest((request) => request + 1);
									}}
								/>
							}
						/>
					) : (
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
					)}
				</div>
				<aside
					className="traffic-inspector"
					hidden={experiment === "2" && !showInspector}
					aria-label={t("traffic.orbit.inspector")}
				>
					{experiment === "2" && (
						<div className="traffic-inspector-heading">
							{selectedNode && (
								<button onClick={() => setFocusRequest((value) => value + 1)}>
									<TrafficIcon name="follow" />
									{t("traffic.nodes.focus")}
								</button>
							)}
							<button
								onClick={() => {
									setShowInspector(false);
									clearSelection();
								}}
							>
								{t("common.close")}
							</button>
						</div>
					)}
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
												: t(filtering ? "traffic.noneMatch" : "traffic.emptyWindow")}
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
