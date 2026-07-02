const stats = {
	"stats.title": "Productivity",
	"stats.tagline": "Proof of how much you ship",
	"stats.back": "Back",
	"stats.refresh": "Refresh",
	// Dashboard entry card
	"stats.cardTitle": "Productivity Stats",
	"stats.cardSubtitle": "Tasks, lines & velocity over time",
	// Time range switch
	"stats.range.day": "Day",
	"stats.range.week": "Week",
	"stats.range.month": "Month",
	"stats.range.all": "All",
	// Period captions (gauge unit)
	"stats.period.day": "today",
	"stats.period.week": "this week",
	"stats.period.month": "this month",
	"stats.period.all": "all-time",
	// Trend suffix (vs previous period)
	"stats.periodPrev.day": "vs yesterday",
	"stats.periodPrev.week": "vs last week",
	"stats.periodPrev.month": "vs prev. 30d",
	"stats.periodPrev.all": "",
	// Neutral trend suffix when browsing a past period (relative-to-now labels don't fit)
	"stats.periodPrev.generic": "vs prev.",
	// Period navigator (prev/next stepper)
	"stats.nav.group": "Time period",
	"stats.nav.prev": "Previous period",
	"stats.nav.next": "Next period",
	"stats.nav.current": "Jump to current period",
	// Relative period labels shown in the navigator
	"stats.rel.dayCurrent": "Today",
	"stats.rel.dayPrev": "Yesterday",
	"stats.rel.dayAgo_one": "{count} day ago",
	"stats.rel.dayAgo_other": "{count} days ago",
	"stats.rel.weekCurrent": "This week",
	"stats.rel.weekPrev": "Last week",
	"stats.rel.weekAgo_one": "{count} week ago",
	"stats.rel.weekAgo_other": "{count} weeks ago",
	"stats.rel.monthCurrent": "This month",
	"stats.rel.monthPrev": "Last month",
	"stats.rel.monthAgo_one": "{count} month ago",
	"stats.rel.monthAgo_other": "{count} months ago",
	// Hero gauge labels (inside the gauge face — keep short)
	"stats.hero.tasksShipped": "Shipped",
	"stats.hero.linesChanged": "Lines",
	"stats.hero.velocity": "Velocity",
	"stats.hero.completionRate": "Done",
	"stats.hero.streak": "Streak",
	// Hero captions (below the gauge)
	"stats.heroCaption.tasksShipped": "Tasks shipped",
	"stats.heroCaption.linesChanged": "Lines changed",
	"stats.heroCaption.velocity": "Tasks per day",
	"stats.heroCaption.completionRate": "Completion rate",
	"stats.heroCaption.streak": "Active-day streak",
	// Units
	"stats.unit.perDay": "/day",
	"stats.unit.percent": "%",
	"stats.unit.days": "days",
	"stats.unit.tasks": "tasks",
	"stats.unit.lines": "LOC",
	// Charts
	"stats.chart.completedTitle": "Tasks completed",
	"stats.chart.linesTitle": "Lines changed",
	"stats.chart.empty": "No activity in this range",
	"stats.locTrackingSince": "LOC tracked since {date}",
	"stats.locNoData": "LOC tracking starts now",
	// Counters
	"stats.counters.tasksTotal": "Total tasks",
	"stats.counters.projectsTouched": "Projects touched",
	"stats.counters.agentsRun": "Agents run",
	"stats.counters.agentsRunHint": "Approximate — counts tasks that launched an agent",
	"stats.counters.allTimeCompleted": "Shipped all-time",
	"stats.counters.bestStreak": "Best streak",
	"stats.counters.tokensUsed": "Tokens used",
	"stats.counters.tokensUsedHint": "Total agent tokens (input + output + cache) for this period, parsed from local Claude Code transcripts.",
	"stats.counters.apiCost": "~API cost",
	"stats.counters.apiCostHint": "What this usage would cost at public API rates. On your subscription it's included/subsidized — not a bill.",
	"stats.counters.apiCostHintPartial": "Estimate excludes some models with unknown pricing, so the real API-rate figure is higher.",
	// Per-project
	"stats.perProject.title": "By project",
	"stats.perProject.empty": "No completed tasks in this period",
	"stats.perProject.busiest": "Busiest project",
	// Per-agent
	"stats.perAgent.title": "By agent",
	"stats.perAgent.empty": "No completed tasks in this period",
	"stats.perAgent.busiest": "Most-used agent",
	"stats.perAgent.total": "shipped",
	// Momentum headline (dynamic subtitle)
	"stats.momentum.fire": "On fire — {pct}% above your usual pace",
	"stats.momentum.ahead": "Up {pct}% — ahead of last period",
	"stats.momentum.behind": "Down {pct}% — time to pick it back up",
	"stats.momentum.steady": "Holding a steady pace",
	"stats.momentum.idle": "Ship a task to get the needle moving",
	"stats.momentum.idlePast": "Nothing shipped in this period",
	"stats.momentum.lifetime": "{count} tasks shipped, all-time. Respect.",
	// Contribution heatmap
	"stats.heatmap.title": "Activity",
	"stats.heatmap.subtitle": "Last 12 months",
	"stats.heatmap.less": "Less",
	"stats.heatmap.more": "More",
	"stats.heatmap.tasks_one": "{count} task",
	"stats.heatmap.tasks_other": "{count} tasks",
	// Milestones
	"stats.milestones.title": "Milestones",
	"stats.milestones.next": "Next",
	"stats.milestones.reachedTip": "{tier} tasks shipped — medal earned",
	"stats.milestones.nextTip": "Next medal at {tier} tasks shipped",
	// LOC empty state (diff tracking just started)
	"stats.locEmpty.title": "Lines changed",
	"stats.locEmpty.body": "Diff tracking just started — your next shipped task fills this in.",
	"stats.locEmpty.badge": "Tracking starts now",
	"stats.locEmpty.chart": "Your first shipped task will fill this in",
	// Empty / error states
	"stats.empty.title": "Ship your first task to light up the cockpit",
	"stats.empty.body": "Complete a task and your stats will appear here.",
	"stats.error": "Couldn't load stats",
	// Command palette
	"command.openStats": "Open Productivity Stats",
} as const;

export default stats;
