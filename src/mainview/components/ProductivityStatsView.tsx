import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProductivityStatEvent } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import type { Route } from "../state";
import { computeProductivityStats, gaugeMax, type StatsRange } from "../utils/productivityStats";
import { Gauge } from "./gauges/Gauge";
import { StatGauge } from "./stats/StatGauge";
import { BarChart } from "./stats/BarChart";
import { AreaChart } from "./stats/AreaChart";
import { TimeRangeSwitch } from "./stats/TimeRangeSwitch";

interface ProductivityStatsViewProps {
	navigate: (route: Route) => void;
	goBack: () => void;
	canGoBack: boolean;
}

const RANGE_KEY = "dev3-stats-range";
const ICON = "'JetBrainsMono Nerd Font Mono'";

function compact(n: number): string {
	return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function loadRange(): StatsRange {
	const v = (typeof localStorage !== "undefined" && localStorage.getItem(RANGE_KEY)) as StatsRange | null;
	return v === "day" || v === "week" || v === "month" || v === "all" ? v : "week";
}

function ProductivityStatsView({ navigate, goBack, canGoBack }: ProductivityStatsViewProps) {
	const t = useT();
	const [events, setEvents] = useState<ProductivityStatEvent[] | null>(null);
	const [error, setError] = useState(false);
	const [loading, setLoading] = useState(true);
	const [range, setRange] = useState<StatsRange>(loadRange);

	const fetchStats = useCallback(() => {
		setLoading(true);
		setError(false);
		api.request
			.getProductivityStats()
			.then((res) => setEvents(res.events))
			.catch(() => setError(true))
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		fetchStats();
	}, [fetchStats]);

	const changeRange = useCallback((r: StatsRange) => {
		setRange(r);
		try {
			localStorage.setItem(RANGE_KEY, r);
		} catch {
			// ignore persistence failures
		}
	}, []);

	const data = useMemo(
		() => computeProductivityStats(events ?? [], range, Date.now()),
		[events, range],
	);

	const rangeLabels: Record<StatsRange, string> = {
		day: t("stats.range.day"),
		week: t("stats.range.week"),
		month: t("stats.range.month"),
		all: t("stats.range.all"),
	};
	const periodLabel = t(`stats.period.${range}` as Parameters<typeof t>[0]);
	const trendSuffix = range === "all" ? undefined : t(`stats.periodPrev.${range}` as Parameters<typeof t>[0]);

	const projMax = gaugeMax(Math.max(0, ...data.perProject.map((p) => p.completed)), 2);
	const agentMax = gaugeMax(Math.max(0, ...data.perAgent.map((a) => a.completed)), 2);

	return (
		<div className="h-full overflow-y-auto">
			<div className="max-w-6xl mx-auto p-7 space-y-6">
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
							<h1 className="text-fg text-xl font-bold leading-tight">{t("stats.title")}</h1>
							<p className="text-fg-3 text-xs">{t("stats.tagline")}</p>
						</div>
					</div>
					<div className="flex items-center gap-2">
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
						{/* Hero gauge cockpit */}
						<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
							<StatGauge
								value={data.hero.tasksShipped.value}
								max={data.hero.tasksShipped.max}
								redZone={data.hero.tasksShipped.redZone ?? undefined}
								label={t("stats.hero.tasksShipped")}
								unit={periodLabel}
								caption={t("stats.heroCaption.tasksShipped")}
								displayValue={String(data.hero.tasksShipped.value)}
								trendPct={data.hero.tasksShipped.trendPct}
								trendSuffix={trendSuffix}
							/>
							<StatGauge
								value={data.hero.linesChanged.value}
								max={data.hero.linesChanged.max}
								redZone={data.hero.linesChanged.redZone ?? undefined}
								label={t("stats.hero.linesChanged")}
								unit={periodLabel}
								caption={t("stats.heroCaption.linesChanged")}
								displayValue={compact(data.hero.linesChanged.value)}
								trendPct={data.hero.linesChanged.trendPct}
								trendSuffix={trendSuffix}
							/>
							<StatGauge
								value={data.hero.velocity.value}
								max={data.hero.velocity.max}
								redZone={data.hero.velocity.redZone ?? undefined}
								label={t("stats.hero.velocity")}
								unit={t("stats.unit.perDay")}
								caption={t("stats.heroCaption.velocity")}
								displayValue={data.hero.velocity.value.toFixed(1)}
								trendPct={data.hero.velocity.trendPct}
								trendSuffix={trendSuffix}
							/>
							<StatGauge
								value={data.hero.completionRate.value}
								max={100}
								redZone={40}
								label={t("stats.hero.completionRate")}
								unit={t("stats.unit.percent")}
								caption={t("stats.heroCaption.completionRate")}
								displayValue={`${data.hero.completionRate.value}%`}
							/>
							<StatGauge
								value={data.hero.streak.value}
								max={data.hero.streak.max}
								label={t("stats.hero.streak")}
								unit={t("stats.unit.days")}
								caption={t("stats.heroCaption.streak")}
								displayValue={`${data.hero.streak.value}`}
							/>
						</div>

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
										{data.locTrackingSince
											? t("stats.locTrackingSince", { date: data.locTrackingSince })
											: t("stats.locNoData")}
									</div>
								</div>
								<AreaChart
									data={data.series.map((b) => ({ label: b.label, value: b.lines, startMs: b.startMs }))}
									formatValue={compact}
									emptyLabel={t("stats.chart.empty")}
								/>
							</div>
						</div>

						{/* Counters strip */}
						<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
							<Counter value={String(data.counters.tasksTotal)} label={t("stats.counters.tasksTotal")} />
							<Counter value={String(data.counters.projectsTouched)} label={t("stats.counters.projectsTouched")} />
							<Counter value={String(data.counters.agentsRun)} label={t("stats.counters.agentsRun")} hint={t("stats.counters.agentsRunHint")} />
							<Counter value={String(data.counters.allTimeCompleted)} label={t("stats.counters.allTimeCompleted")} />
							<Counter value={String(data.counters.bestStreak)} label={t("stats.counters.bestStreak")} />
						</div>

						{/* Per-project gauge wall */}
						<div>
							<div className="text-fg-2 text-sm font-semibold mb-3">{t("stats.perProject.title")}</div>
							{data.perProject.length === 0 ? (
								<div className="text-fg-muted text-xs py-6 text-center">{t("stats.perProject.empty")}</div>
							) : (
								<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
									{data.perProject.map((p) => (
										<button
											type="button"
											key={p.projectId}
											onClick={() => navigate({ screen: "project", projectId: p.projectId })}
											className={`group flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition-colors ${
												p.busiest ? "border-accent/50 bg-accent/5 hover:bg-accent/10" : "border-edge bg-raised hover:bg-raised-hover"
											}`}
										>
											<Gauge value={p.completed} max={projMax} size={104} label={String(p.completed)} unit={t("stats.unit.tasks")} theme="auto" />
											<div className="text-fg text-xs font-semibold truncate max-w-full text-center flex items-center gap-1">
												{p.busiest && <span className="text-accent" style={{ fontFamily: ICON }} title={t("stats.perProject.busiest")}>{"\u{F0241}"}</span>}
												<span className="truncate">{p.name}</span>
											</div>
											<div className="text-fg-muted text-[0.625rem]">{compact(p.lines)} {t("stats.unit.lines")}</div>
										</button>
									))}
								</div>
							)}
						</div>

						{/* Per-agent gauge wall — tasks shipped by each agent type */}
						<div>
							<div className="text-fg-2 text-sm font-semibold mb-3">{t("stats.perAgent.title")}</div>
							{data.perAgent.length === 0 ? (
								<div className="text-fg-muted text-xs py-6 text-center">{t("stats.perAgent.empty")}</div>
							) : (
								<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
									{data.perAgent.map((a) => (
										<div
											key={a.agentId}
											className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 ${
												a.busiest ? "border-accent/50 bg-accent/5" : "border-edge bg-raised"
											}`}
										>
											<Gauge value={a.completed} max={agentMax} size={104} label={String(a.completed)} unit={t("stats.unit.tasks")} theme="auto" />
											<div className="text-fg text-xs font-semibold truncate max-w-full text-center flex items-center gap-1">
												{a.busiest && <span className="text-accent" style={{ fontFamily: ICON }} title={t("stats.perAgent.busiest")}>{"\u{F0241}"}</span>}
												<span className="truncate">{a.name}</span>
											</div>
											<div className="text-fg-muted text-[0.625rem]">{compact(a.lines)} {t("stats.unit.lines")}</div>
										</div>
									))}
								</div>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function Counter({ value, label, hint }: { value: string; label: string; hint?: string }) {
	return (
		<div className="rounded-xl border border-edge bg-raised px-4 py-3 flex flex-col gap-0.5" title={hint}>
			<div className="text-fg text-2xl font-bold tabular-nums leading-none">{value}</div>
			<div className="text-fg-3 text-xs">{label}</div>
		</div>
	);
}

export default ProductivityStatsView;
