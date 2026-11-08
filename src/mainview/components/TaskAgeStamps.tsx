import type { Task } from "../../shared/types";
import { useLocale, useT } from "../i18n";
import { useSharedNow } from "../hooks/useNow";
import { ageParts, compactAge, freshness, type AgeUnit, type Freshness } from "../utils/statusAge";
import Tooltip from "./Tooltip";

const NERD_FONT = { fontFamily: "'JetBrainsMono Nerd Font Mono'" } as const;
const CALENDAR_GLYPH = "\u{F073}";
const CLOCK_GLYPH = "\u{F017}";

/** Maps the single most-significant age unit to its verbose i18n key. */
const AGE_UNIT_KEY: Record<AgeUnit, string> = {
	s: "activity.secondsAgo",
	m: "activity.minutesAgo",
	h: "activity.hoursAgo",
	d: "activity.daysAgo",
	M: "activity.monthsAgo",
	y: "activity.yearsAgo",
};

/** Recent activity draws the eye; old activity sinks to the same grey as the creation date. */
const FRESHNESS_CLASS: Record<Freshness, string> = {
	live: "text-accent",
	recent: "text-accent/70",
	today: "text-fg-2",
	stale: "text-fg-muted",
};

/** Which stamps fit: both, only the last-activity one, or none (a crowded card header). */
export type AgeStampsFit = "both" | "activity" | "none";

interface TaskAgeStampsProps {
	task: Pick<Task, "createdAt" | "movedAt">;
	now: number;
	testId: string;
	fit?: AgeStampsFit;
}

/**
 * The task's two clocks side by side: when it was created (calendar, muted) and
 * when it last changed status (clock, coloured by freshness). A task that never
 * moved has been in its column since creation, so its activity is `createdAt`.
 */
export default function TaskAgeStamps({ task, now, testId, fit = "both" }: TaskAgeStampsProps) {
	const t = useT();
	const [locale] = useLocale();
	if (fit === "none") return null;

	const activityAt = task.movedAt ?? task.createdAt;
	const tier = freshness(activityAt, now) ?? "stale";

	const agoPhrase = (iso: string) => {
		const part = ageParts(iso, now);
		if (!part || (part.unit === "s" && part.value < 1)) return t("activity.justNow");
		return t(AGE_UNIT_KEY[part.unit] as Parameters<typeof t>[0], { count: String(part.value) });
	};
	const dateOf = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

	const createdLabel = t("task.age.created", { ago: agoPhrase(task.createdAt), date: dateOf(task.createdAt) });
	const activityLabel = task.movedAt
		? t("task.age.statusChanged", { ago: agoPhrase(task.movedAt), date: dateOf(task.movedAt) })
		: t("task.age.unchangedSinceCreated");

	return (
		<span data-testid={testId} className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-nano">
			{fit === "both" && (
				<Tooltip content={createdLabel}>
					<span data-testid={`${testId}-created`} className="flex items-center gap-0.5 text-fg-muted">
						<span aria-hidden className="leading-none" style={NERD_FONT}>{CALENDAR_GLYPH}</span>
						<span aria-hidden>{compactAge(task.createdAt, now)}</span>
						<span className="sr-only">{createdLabel}</span>
					</span>
				</Tooltip>
			)}
			<Tooltip content={activityLabel}>
				<span
					data-testid={`${testId}-activity`}
					data-freshness={tier}
					className={`flex items-center gap-0.5 font-semibold transition-colors duration-300 ${FRESHNESS_CLASS[tier]}`}
				>
					<span aria-hidden className="leading-none" style={NERD_FONT}>{CLOCK_GLYPH}</span>
					<span aria-hidden>{compactAge(activityAt, now)}</span>
					<span className="sr-only">{activityLabel}</span>
				</span>
			</Tooltip>
		</span>
	);
}

/** The same stamps on the shared 15s clock, for surfaces that have no clock of their own. */
export function LiveTaskAgeStamps(props: Omit<TaskAgeStampsProps, "now">) {
	const now = useSharedNow();
	return <TaskAgeStamps {...props} now={now} />;
}
