import {
	attentionSessions,
	formatCostUsd,
	sessionAttention,
	summarizeSessions,
	type ClaudeSessionStats,
} from "../../shared/session-stats";
import { useNow } from "../hooks/useNow";
import { useT } from "../i18n";
import { CacheState, contextTone } from "./session-stats-ui";

function AttentionRow({ session, now }: { session: ClaudeSessionStats; now: number }) {
	const t = useT();
	const reason = sessionAttention(session, now);
	const percent = Math.round(session.contextPercent ?? 0);
	return (
		<li className="flex items-baseline gap-1.5 rounded-md px-2 py-1 bg-raised/65">
			{session.taskSeq != null && <span className="shrink-0 tabular-nums text-fg-muted">#{session.taskSeq}</span>}
			<span className="min-w-0 flex-1 truncate text-fg-2" title={session.taskTitle ?? undefined}>
				{session.taskTitle}
			</span>
			<span className="shrink-0 whitespace-nowrap tabular-nums">
				{reason === "cacheExpiring" ? (
					<CacheState session={session} now={now} />
				) : (
					<span className={contextTone(percent)}>{t("rateLimits.sessionContext", { percent })}</span>
				)}
			</span>
		</li>
	);
}

/**
 * The usage panel's bounded Sessions strip: one summary line, at most
 * MAX_ATTENTION_SESSIONS rows that need the user now, and the way into the full
 * Sessions screen. It never grows with the task count. Absent with no sessions.
 */
export default function UsageSessionsStrip({
	sessions,
	onOpenAll,
}: {
	sessions: readonly ClaudeSessionStats[];
	onOpenAll?: () => void;
}) {
	const t = useT();
	const now = useNow();
	if (sessions.length === 0) return null;
	const summary = summarizeSessions(sessions, now);
	const attention = attentionSessions(sessions, now);
	const parts = [t.plural("rateLimits.sessionsCount", summary.count)];
	if (summary.warm > 0) parts.push(t.plural("rateLimits.sessionsWarm", summary.warm));
	if (summary.costUsd != null) parts.push(formatCostUsd(summary.costUsd));
	return (
		<section aria-labelledby="usage-sessions-title" className="space-y-1">
			<div className="flex items-baseline gap-2 px-2">
				<h3 id="usage-sessions-title" className="text-fg-muted text-micro font-semibold uppercase tracking-wider">
					{t("rateLimits.sessionsTitle")}
				</h3>
				<span className="min-w-0 flex-1 truncate tabular-nums text-fg-3">{parts.join(" · ")}</span>
				{onOpenAll && (
					<button
						type="button"
						onClick={onOpenAll}
						className="shrink-0 rounded text-accent hover:text-accent-emphasis hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
					>
						{t("rateLimits.sessionsAll")}
					</button>
				)}
			</div>
			{attention.length > 0 && (
				<ul className="space-y-1">
					{attention.map((session) => (
						<AttentionRow key={session.taskId} session={session} now={now} />
					))}
				</ul>
			)}
		</section>
	);
}
