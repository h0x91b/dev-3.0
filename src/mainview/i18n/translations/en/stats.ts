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
	// Per-project
	"stats.perProject.title": "By project",
	"stats.perProject.empty": "No completed tasks in this period",
	"stats.perProject.busiest": "Busiest project",
	// Per-agent
	"stats.perAgent.title": "By agent",
	"stats.perAgent.empty": "No completed tasks in this period",
	"stats.perAgent.busiest": "Most-used agent",
	"stats.perAgent.total": "shipped",
	// Empty / error states
	"stats.empty.title": "Ship your first task to light up the cockpit",
	"stats.empty.body": "Complete a task and your stats will appear here.",
	"stats.error": "Couldn't load stats",
	// Command palette
	"command.openStats": "Open Productivity Stats",
} as const;

export default stats;
