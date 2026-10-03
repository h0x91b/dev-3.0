import type { ReactNode } from "react";
import {
	CONTEXT_ATTENTION_PERCENT,
	formatDurationMs,
	formatTokenCount,
	isSessionCacheWarm,
	sessionAttention,
	type ClaudeSessionStats,
} from "../../shared/session-stats";
import { useLocale, useT } from "../i18n";

/** Context fills earlier than a limit window matters, so it escalates at 60/85, not 80/95. */
export function contextTone(percent: number): string {
	if (percent >= CONTEXT_ATTENTION_PERCENT) return "text-danger";
	if (percent >= 60) return "text-warning-strong";
	return "text-fg-2";
}

function contextFill(percent: number): string {
	if (percent >= CONTEXT_ATTENTION_PERCENT) return "bg-danger";
	if (percent >= 60) return "bg-warning";
	return "bg-accent";
}

export function ContextBar({ percent }: { percent: number }) {
	const clamped = Math.max(0, Math.min(100, percent));
	return (
		<span aria-hidden="true" className="relative inline-block h-1 w-10 overflow-hidden rounded-full bg-fg/10 align-middle">
			<span
				className={`absolute inset-y-0 left-0 rounded-full ${contextFill(percent)}`}
				style={{ width: `${clamped}%`, minWidth: clamped > 0 ? "0.2rem" : undefined }}
			/>
		</span>
	);
}

/** Warm/cold with TTL and expiry; an expiry the user can still save reads as a countdown. */
export function CacheState({ session, now }: { session: ClaudeSessionStats; now: number }) {
	const t = useT();
	const [locale] = useLocale();
	const cache = session.cache;
	if (!cache) return <span className="text-fg-muted">-</span>;
	const warm = isSessionCacheWarm(cache, now);
	if (!warm) return <span className="text-fg-muted">{t("rateLimits.sessionCacheCold")}</span>;
	if (sessionAttention(session, now) === "cacheExpiring") {
		return (
			<span className="text-warning-strong">
				{t("rateLimits.sessionCacheExpiresIn", { time: formatDurationMs(Math.max(0, cache.expiresAt! - now)) })}
			</span>
		);
	}
	if (cache.expiresAt == null) return <span className="text-accent">{t("rateLimits.sessionCacheWarm")}</span>;
	const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(cache.expiresAt);
	return (
		<span className="text-accent">
			{cache.ttl
				? t("rateLimits.sessionCacheWarmTtlUntil", { ttl: cache.ttl, time })
				: t("rateLimits.sessionCacheWarmUntil", { time })}
		</span>
	);
}

/** Everything the statusLine reports beyond the table's columns, for a row's disclosure. */
export function SessionDetails({ session }: { session: ClaudeSessionStats }) {
	const t = useT();
	const items: ReactNode[] = [];
	const push = (key: string, node: ReactNode) => items.push(<span key={key}>{node}</span>);
	if (session.sessionName) push("sessionName", <span className="text-fg-2 streamer-private">{session.sessionName}</span>);
	if (session.totalTokens != null) {
		push("tokens", t("rateLimits.sessionTokens", { tokens: formatTokenCount(session.totalTokens) }));
	}
	if (session.turnInputTokens || session.turnOutputTokens) {
		push(
			"turn",
			t("rateLimits.sessionTurn", {
				input: formatTokenCount(session.turnInputTokens ?? 0),
				output: formatTokenCount(session.turnOutputTokens ?? 0),
			}),
		);
	}
	if (session.cacheReadTokens != null || session.cacheWriteTokens != null) {
		push(
			"cacheTokens",
			t("rateLimits.sessionCacheTokens", {
				read: formatTokenCount(session.cacheReadTokens ?? 0),
				write: formatTokenCount(session.cacheWriteTokens ?? 0),
			}),
		);
	}
	if (session.cache?.hitRatio != null) {
		push("hit", t("rateLimits.sessionCacheHit", { percent: Math.round(session.cache.hitRatio * 100) }));
	}
	if (session.durationMs) {
		push(
			"duration",
			t("rateLimits.sessionDuration", {
				time: formatDurationMs(session.durationMs),
				api: formatDurationMs(session.apiDurationMs ?? 0),
			}),
		);
	}
	if (session.linesAdded || session.linesRemoved) {
		push("lines", t("rateLimits.sessionLines", { added: session.linesAdded ?? 0, removed: session.linesRemoved ?? 0 }));
	}
	if (session.effort) push("effort", t("rateLimits.sessionEffort", { level: session.effort }));
	if (session.thinking) push("thinking", t("rateLimits.sessionThinking"));
	if (items.length === 0) return null;
	return <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-fg-3">{items}</div>;
}
