import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentUsageDay, ProductivityStatEvent } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import type { Route } from "../state";
import { computeProductivityStats, gaugeMax, type StatsRange } from "../utils/productivityStats";
import { StatGauge } from "./stats/StatGauge";
import { BarChart } from "./stats/BarChart";
import { AreaChart } from "./stats/AreaChart";
import { AgentPie } from "./stats/AgentPie";
import { SegmentedBar } from "./stats/SegmentedBar";
import { ContributionHeatmap } from "./stats/ContributionHeatmap";
import { Milestones } from "./stats/Milestones";
import { CountUp } from "./stats/CountUp";
import { TimeRangeSwitch } from "./stats/TimeRangeSwitch";
import { PeriodStepper } from "./stats/PeriodStepper";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import HelpSpot from "./HelpSpot";

interface ProductivityStatsViewProps {
	navigate: (route: Route) => void;
	goBack: () => void;
	canGoBack: boolean;
}

const RANGE_KEY = "dev3-stats-range";
const ICON = "'JetBrainsMono Nerd Font Mono'";
const FIRE = "\u{F0238}";

function compact(n: number): string {
	return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

const fmtInt = (n: number): string => String(Math.round(n));
const fmtPct = (n: number): string => `${Math.round(n)}%`;
const fmtOne = (n: number): string => n.toFixed(1);
/** Compact-with-sub-unit currency: "$0.42", "$12.30", "$1.2K". */
const fmtUsd = (n: number): string =>
	n >= 1000
		? `$${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)}`
		: `$${n.toFixed(2)}`;

/** Only surface a red "beat-your-average" zone once there's a real average (>0). */
function redZoneOf(avg: number | null): number | undefined {
	return avg != null && avg > 0 ? avg : undefined;
}

function loadRange(): StatsRange {
	const v = (typeof localStorage !== "undefined" && localStorage.getItem(RANGE_KEY)) as StatsRange | null;
	return v === "day" || v === "week" || v === "month" || v === "all" ? v : "week";
}

function ProductivityStatsView({ navigate, goBack, canGoBack }: ProductivityStatsViewProps) {
	const t = useT();
	// Phone widths can't fit the speedometer cockpit — swap it for compact stat
	// cards and tighten page padding.
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [events, setEvents] = useState<ProductivityStatEvent[] | null>(null);
	// Agent token/cost usage (supplementary — never blocks the dashboard on failure).
	const [usage, setUsage] = useState<AgentUsageDay[] | null>(null);
	const [error, setError] = useState(false);
	const [loading, setLoading] = useState(true);
	const [range, setRange] = useState<StatsRange>(loadRange);
	// Periods stepped back from now (0 = current). Ephemeral — resets on range change.
	const [offset, setOffset] = useState(0);

	const fetchStats = useCallback(() => {
		setLoading(true);
		setError(false);
		api.request
			.getProductivityStats()
			.then((res) => setEvents(res.events))
			.catch(() => setError(true))
			.finally(() => setLoading(false));
		// Best-effort: token/cost usage is additive; a failure just hides the two counters.
		api.request
			.getAgentUsage()
			.then((res) => setUsage(res.days))
			.catch(() => setUsage([]));
	}, []);

	useEffect(() => {
		fetchStats();
	}, [fetchStats]);

	const changeRange = useCallback((r: StatsRange) => {
		setRange(r);
		// Offsets aren't comparable across granularities — snap back to the present.
		setOffset(0);
		try {
			localStorage.setItem(RANGE_KEY, r);
		} catch {
			// ignore persistence failures
		}
	}, []);

	const data = useMemo(
		() => computeProductivityStats(events ?? [], range, Date.now(), offset),
		[events, range, offset],
	);

	// Token/cost totals for the visible period. "all" sums everything; other ranges
	// filter by the same [periodFrom, periodTo] window the task stats use (day-aligned).
	const usagePeriod = useMemo(() => {
		const rows = usage ?? [];
		const inPeriod =
			range === "all"
				? rows
				: rows.filter((r) => r.startMs >= data.periodFrom && r.startMs <= data.periodTo);
		let tokens = 0;
		let cost = 0;
		let fullyPriced = true;
		for (const r of inPeriod) {
			tokens += r.inputTokens + r.outputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens;
			cost += r.costUsd;
			if (!r.fullyPriced) fullyPriced = false;
		}
		return { tokens, cost, fullyPriced, hasData: rows.length > 0 };
	}, [usage, range, data.periodFrom, data.periodTo]);

	const rangeLabels: Record<StatsRange, string> = {
		day: t("stats.range.day"),
		week: t("stats.range.week"),
		month: t("stats.range.month"),
		all: t("stats.range.all"),
	};
	const periodLabel = t(`stats.period.${range}` as Parameters<typeof t>[0]);
	// When navigated into the past, "vs yesterday/last week" is misleading — use a neutral suffix.
	const trendSuffix =
		range === "all"
			? undefined
			: offset > 0
				? t("stats.periodPrev.generic")
				: t(`stats.periodPrev.${range}` as Parameters<typeof t>[0]);

	// Relative label for the period navigator (e.g. "Today", "Last week", "3 months ago").
	const periodNavLabel = (() => {
		const base = range === "day" ? "day" : range === "month" ? "month" : "week";
		if (offset === 0) return t(`stats.rel.${base}Current` as Parameters<typeof t>[0]);
		if (offset === 1) return t(`stats.rel.${base}Prev` as Parameters<typeof t>[0]);
		return t.plural(`stats.rel.${base}Ago` as Parameters<typeof t.plural>[0], offset);
	})();
	const periodRange = `${new Date(data.periodFrom).toLocaleDateString()} – ${new Date(data.periodTo).toLocaleDateString()}`;
	const periodNavTitle = offset === 0 ? periodRange : `${t("stats.nav.current")} · ${periodRange}`;

	const projMax = gaugeMax(Math.max(0, ...data.perProject.map((p) => p.completed)), 2);

	const momentumText = (() => {
		const { state, pct } = data.momentum;
		switch (state) {
			case "fire":
				return t("stats.momentum.fire", { pct: String(pct ?? 0) });
			case "ahead":
				return t("stats.momentum.ahead", { pct: String(pct ?? 0) });
			case "behind":
				return t("stats.momentum.behind", { pct: String(pct ?? 0) });
			case "lifetime":
				return t("stats.momentum.lifetime", { count: String(data.counters.allTimeCompleted) });
			case "idle":
				// "Ship a task" only makes sense for the present period.
				return offset > 0 ? t("stats.momentum.idlePast") : t("stats.momentum.idle");
			default:
				return t("stats.momentum.steady");
		}
	})();

	return (
		<div className="h-full overflow-y-auto">
			<div className={`max-w-6xl mx-auto space-y-6 ${narrow ? "p-4" : "p-7"}`}>
				{/* Header */}
				<div className="flex items-center justify-between gap-4 flex-wrap">
					<div className="flex items-center gap-3 min-w-0">
						{canGoBack && (
							<button
								type="button"
								onClick={goBack}
								className="text-fg-3 hover:text-fg hover:bg-elevated rounded-lg p-1.5 transition-colors"
								title={t("stats.back")}
							>
								<span className="text-base leading-none" style={{ fontFamily: ICON }}>{"\u{F0141}"}</span>
							</button>
						)}
						<span className="text-accent text-2xl leading-none" style={{ fontFamily: ICON }}>{"\u{F04C5}"}</span>
						<div className="min-w-0">
							<div className="flex items-center gap-1.5">
								<h1 className="text-fg text-xl font-bold leading-tight">{t("stats.title")}</h1>
								<HelpSpot topicId="stats.overview" />
							</div>
							{data.hasAnyData ? (
								<p className={`text-xs flex items-center gap-1 ${data.onFire ? "text-stat-fire font-semibold" : "text-fg-3"}`}>
									{data.onFire && <span className="leading-none" style={{ fontFamily: ICON }}>{FIRE}</span>}
									<span>{momentumText}</span>
								</p>
							) : (
								<p className="text-fg-3 text-xs">{t("stats.tagline")}</p>
							)}
						</div>
					</div>
					<div className="flex items-center gap-2 flex-wrap justify-end">
						{range !== "all" && (
							<PeriodStepper
								label={periodNavLabel}
								labelTitle={periodNavTitle}
								groupLabel={t("stats.nav.group")}
								atCurrent={offset === 0}
								canOlder={data.canGoOlder}
								canNewer={data.canGoNewer}
								onOlder={() => setOffset((o) => o + 1)}
								onNewer={() => setOffset((o) => Math.max(0, o - 1))}
								onReset={() => setOffset(0)}
								prevLabel={t("stats.nav.prev")}
								nextLabel={t("stats.nav.next")}
							/>
						)}
						<TimeRangeSwitch value={range} onChange={changeRange} labels={rangeLabels} />
						<button
							type="button"
							onClick={fetchStats}
							className="text-fg-3 hover:text-fg hover:bg-elevated rounded-lg p-1.5 transition-colors"
							title={t("stats.refresh")}
						>
							<span className="text-base leading-none" style={{ fontFamily: ICON }}>{"\u{F0450}"}</span>
						</button>
					</div>
				</div>

				{loading && events === null ? (
					<div className="flex items-center justify-center py-24">
						<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
					</div>
				) : error ? (
					<div className="flex flex-col items-center justify-center py-24 gap-3">
						<p className="text-fg-2">{t("stats.error")}</p>
						<button
							type="button"
							onClick={fetchStats}
							className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover transition-colors"
						>
							{t("stats.refresh")}
						</button>
					</div>
				) : !data.hasAnyData ? (
					<div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
						<span className="text-fg-muted text-5xl leading-none" style={{ fontFamily: ICON }}>{"\u{F04C5}"}</span>
						<p className="text-fg-2 text-lg font-medium mt-2">{t("stats.empty.title")}</p>
						<p className="text-fg-3 text-sm">{t("stats.empty.body")}</p>
					</div>
				) : (
					<>
						{/* Hero gauge cockpit — compact stat cards on phones, speedometers on wide */}
						{narrow ? (
							<div className="grid grid-cols-2 gap-2" data-testid="hero-stats-compact">
								<HeroStat
									value={data.hero.tasksShipped.value}
									format={fmtInt}
									caption={t("stats.heroCaption.tasksShipped")}
									unit={periodLabel}
									trendPct={data.hero.tasksShipped.trendPct}
									trendSuffix={trendSuffix}
								/>
								{data.hasAnyLines ? (
									<HeroStat
										value={data.hero.linesChanged.value}
										format={compact}
										caption={t("stats.heroCaption.linesChanged")}
										unit={periodLabel}
										trendPct={data.hero.linesChanged.trendPct}
										trendSuffix={trendSuffix}
									/>
								) : (
									<CompactLocPlaceholder label={t("stats.hero.linesChanged")} body={t("stats.locEmpty.badge")} />
								)}
								<HeroStat
									value={data.hero.velocity.value}
									format={fmtOne}
									caption={t("stats.heroCaption.velocity")}
									unit={t("stats.unit.perDay")}
									trendPct={data.hero.velocity.trendPct}
									trendSuffix={trendSuffix}
								/>
								<HeroStat
									value={data.hero.completionRate.value}
									format={fmtPct}
									caption={t("stats.heroCaption.completionRate")}
								/>
								<HeroStat
									value={data.hero.streak.value}
									format={fmtInt}
									caption={t("stats.heroCaption.streak")}
									unit={t("stats.unit.days")}
								/>
							</div>
						) : (
						<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
							<StatGauge
								value={data.hero.tasksShipped.value}
								max={data.hero.tasksShipped.max}
								redZone={redZoneOf(data.hero.tasksShipped.redZone)}
								redZoneMode="above"
								label={t("stats.hero.tasksShipped")}
								unit={periodLabel}
								caption={t("stats.heroCaption.tasksShipped")}
								format={fmtInt}
								trendPct={data.hero.tasksShipped.trendPct}
								trendSuffix={trendSuffix}
							/>
							{data.hasAnyLines ? (
								<StatGauge
									value={data.hero.linesChanged.value}
									max={data.hero.linesChanged.max}
									redZone={redZoneOf(data.hero.linesChanged.redZone)}
									redZoneMode="above"
									label={t("stats.hero.linesChanged")}
									unit={periodLabel}
									caption={t("stats.heroCaption.linesChanged")}
									format={compact}
									trendPct={data.hero.linesChanged.trendPct}
									trendSuffix={trendSuffix}
								/>
							) : (
								<LocPlaceholder label={t("stats.hero.linesChanged")} body={t("stats.locEmpty.body")} />
							)}
							<StatGauge
								value={data.hero.velocity.value}
								max={data.hero.velocity.max}
								redZone={redZoneOf(data.hero.velocity.redZone)}
								redZoneMode="above"
								label={t("stats.hero.velocity")}
								unit={t("stats.unit.perDay")}
								caption={t("stats.heroCaption.velocity")}
								format={fmtOne}
								trendPct={data.hero.velocity.trendPct}
								trendSuffix={trendSuffix}
							/>
							<StatGauge
								value={data.hero.completionRate.value}
								max={100}
								label={t("stats.hero.completionRate")}
								unit={t("stats.unit.percent")}
								caption={t("stats.heroCaption.completionRate")}
								format={fmtPct}
							/>
							<StatGauge
								value={data.hero.streak.value}
								max={data.hero.streak.max}
								label={t("stats.hero.streak")}
								unit={t("stats.unit.days")}
								caption={t("stats.heroCaption.streak")}
								format={fmtInt}
							/>
						</div>
						)}

						{/* Charts */}
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
							<div className="rounded-2xl border border-edge bg-raised p-4">
								<div className="text-fg-2 text-sm font-semibold mb-3">{t("stats.chart.completedTitle")}</div>
								<BarChart
									data={data.series.map((b) => ({ label: b.label, value: b.completed, startMs: b.startMs }))}
									formatValue={(n) => `${n}`}
									emptyLabel={t("stats.chart.empty")}
								/>
							</div>
							<div className="rounded-2xl border border-edge bg-raised p-4">
								<div className="flex items-center justify-between mb-3">
									<div className="text-fg-2 text-sm font-semibold">{t("stats.chart.linesTitle")}</div>
									<div className="text-fg-muted text-[0.625rem]">
										{!data.hasAnyLines
											? t("stats.locEmpty.badge")
											: data.locTrackingSince
												? t("stats.locTrackingSince", { date: data.locTrackingSince })
												: t("stats.locNoData")}
									</div>
								</div>
								<AreaChart
									data={data.series.map((b) => ({ label: b.label, value: b.lines, startMs: b.startMs }))}
									formatValue={compact}
									emptyLabel={data.hasAnyLines ? t("stats.chart.empty") : t("stats.locEmpty.chart")}
								/>
							</div>
						</div>

						{/* Contribution heatmap — a year of shipping at a glance (range-independent) */}
						<div>
							<div className="flex items-center justify-between mb-3">
								<div className="text-fg-2 text-sm font-semibold">{t("stats.heatmap.title")}</div>
								<div className="text-fg-muted text-[0.625rem]">{t("stats.heatmap.subtitle")}</div>
							</div>
							<div className="rounded-2xl border border-edge bg-raised p-4">
								<ContributionHeatmap
									days={data.heatmap.days}
									maxCount={data.heatmap.maxCount}
									legendLess={t("stats.heatmap.less")}
									legendMore={t("stats.heatmap.more")}
									tooltipFor={(count, ms) =>
										`${t.plural("stats.heatmap.tasks", count)} · ${new Date(ms).toLocaleDateString()}`
									}
								/>
							</div>
						</div>

						{/* Counters strip */}
						<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
							<Counter value={data.counters.tasksTotal} label={t("stats.counters.tasksTotal")} />
							<Counter value={data.counters.projectsTouched} label={t("stats.counters.projectsTouched")} />
							<Counter value={data.counters.agentsRun} label={t("stats.counters.agentsRun")} hint={t("stats.counters.agentsRunHint")} />
							<Counter value={data.counters.allTimeCompleted} label={t("stats.counters.allTimeCompleted")} />
							<Counter value={data.counters.bestStreak} label={t("stats.counters.bestStreak")} />
							{usagePeriod.hasData && (
								<>
									<Counter
										value={usagePeriod.tokens}
										label={t("stats.counters.tokensUsed")}
										hint={t("stats.counters.tokensUsedHint")}
										format={compact}
									/>
									<Counter
										value={usagePeriod.cost}
										label={t("stats.counters.apiCost")}
										hint={
											usagePeriod.fullyPriced
												? t("stats.counters.apiCostHint")
												: `${t("stats.counters.apiCostHint")} ${t("stats.counters.apiCostHintPartial")}`
										}
										format={fmtUsd}
									/>
								</>
							)}
						</div>

						{/* Lifetime shipping medals */}
						<div>
							<div className="text-fg-2 text-sm font-semibold mb-3">{t("stats.milestones.title")}</div>
							<Milestones
								reached={data.milestones.reached}
								next={data.milestones.next}
								current={data.milestones.current}
								format={compact}
								nextLabel={t("stats.milestones.next")}
								tooltipReached={(tier) => t("stats.milestones.reachedTip", { tier: compact(tier) })}
								tooltipNext={(tier) => t("stats.milestones.nextTip", { tier: compact(tier) })}
							/>
						</div>

						{/* Per-project breakdown — segmented LED bars, tasks shipped per project */}
						<div>
							<div className="text-fg-2 text-sm font-semibold mb-3">{t("stats.perProject.title")}</div>
							{data.perProject.length === 0 ? (
								<div className="text-fg-muted text-xs py-6 text-center">{t("stats.perProject.empty")}</div>
							) : (
								<div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
									{data.perProject.map((p) => (
										<button
											type="button"
											key={p.projectId}
											onClick={() => navigate({ screen: "project", projectId: p.projectId })}
											className={`group flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
												p.busiest ? "border-accent/50 bg-accent/5 hover:bg-accent/10" : "border-edge bg-raised hover:bg-raised-hover"
											}`}
										>
											<div className="flex items-center justify-between gap-2">
												<span className="text-fg text-xs font-semibold truncate flex items-center gap-1 min-w-0">
													{p.busiest && <span className="text-accent flex-shrink-0" style={{ fontFamily: ICON }} title={t("stats.perProject.busiest")}>{"\u{F0241}"}</span>}
													<span className="truncate">{p.name}</span>
												</span>
												<span className="text-fg text-sm font-bold tabular-nums flex-shrink-0">{p.completed}</span>
											</div>
											<SegmentedBar value={p.completed} max={projMax} ariaLabel={`${p.name}: ${p.completed} ${t("stats.unit.tasks")}`} />
											{p.lines > 0 && (
												<div className="text-fg-muted text-[0.625rem]">{compact(p.lines)} {t("stats.unit.lines")}</div>
											)}
										</button>
									))}
								</div>
							)}
						</div>

						{/* Per-agent breakdown — donut of tasks shipped by agent type */}
						<div>
							<div className="text-fg-2 text-sm font-semibold mb-3">{t("stats.perAgent.title")}</div>
							{data.perAgent.length === 0 ? (
								<div className="text-fg-muted text-xs py-6 text-center">{t("stats.perAgent.empty")}</div>
							) : (
								<div className="rounded-2xl border border-edge bg-raised p-4 max-w-md">
									<AgentPie
										data={data.perAgent}
										tasksLabel={t("stats.unit.tasks")}
										linesLabel={t("stats.unit.lines")}
										totalLabel={t("stats.perAgent.total")}
									/>
								</div>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function Counter({
	value,
	label,
	hint,
	format = fmtInt,
}: {
	value: number;
	label: string;
	hint?: string;
	format?: (n: number) => string;
}) {
	return (
		<div className="rounded-xl border border-edge bg-raised px-4 py-3 flex flex-col gap-0.5" title={hint}>
			<div className="text-fg text-2xl font-bold tabular-nums leading-none">
				<CountUp value={value} format={format} />
			</div>
			<div className="text-fg-3 text-xs">{label}</div>
		</div>
	);
}

/**
 * Compact hero metric card for narrow (phone) viewports. Conveys the same number
 * + trend as the desktop {@link StatGauge} speedometer at a fraction of the height.
 */
function HeroStat({
	value,
	format,
	displayValue,
	caption,
	unit,
	trendPct,
	trendSuffix,
}: {
	value: number;
	format?: (n: number) => string;
	displayValue?: string;
	caption: string;
	unit?: string;
	trendPct?: number | null;
	trendSuffix?: string;
}) {
	const hasTrend = trendPct != null;
	const up = (trendPct ?? 0) >= 0;
	return (
		<div className="flex flex-col gap-1 rounded-xl border border-edge bg-raised px-3 py-2.5">
			<div className="flex items-baseline justify-between gap-1.5">
				<span className="text-fg text-[1.375rem] font-bold tabular-nums leading-none">
					{format ? <CountUp value={value} format={format} /> : (displayValue ?? String(value))}
				</span>
				{hasTrend && (
					<span
						className={`inline-flex items-center gap-0.5 text-[0.6875rem] font-semibold tabular-nums ${up ? "text-success" : "text-danger"}`}
						title={trendSuffix}
					>
						<span>{up ? "▲" : "▼"}</span>
						<span>{Math.abs(trendPct ?? 0)}%</span>
					</span>
				)}
			</div>
			<div className="text-fg-2 text-xs font-semibold leading-tight">{caption}</div>
			{unit && <div className="text-fg-muted text-[0.625rem] leading-tight">{unit}</div>}
		</div>
	);
}

/** Compact Lines placeholder for narrow viewports (desktop uses a tall dashed card). */
function CompactLocPlaceholder({ label, body }: { label: string; body: string }) {
	return (
		<div className="flex flex-col gap-1 rounded-xl border border-edge border-dashed bg-raised px-3 py-2.5">
			<div className="text-fg-2 text-xs font-semibold leading-tight">{label}</div>
			<div className="text-fg-muted text-[0.625rem] leading-tight">{body}</div>
		</div>
	);
}

/** Placeholder shown in the Lines gauge slot before any diff data exists. */
function LocPlaceholder({ label, body }: { label: string; body: string }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-edge border-dashed bg-raised px-4 py-4 text-center min-h-[17rem]">
			<span className="text-fg-muted text-4xl leading-none" style={{ fontFamily: ICON }}>{"\u{F0645}"}</span>
			<div className="text-fg-2 text-sm font-semibold">{label}</div>
			<div className="text-fg-muted text-xs max-w-[12rem]">{body}</div>
		</div>
	);
}

export default ProductivityStatsView;
