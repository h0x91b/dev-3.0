import { useEffect, useState } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import {
	RATE_LIMIT_DANGER_PERCENT,
	RATE_LIMIT_WARN_PERCENT,
	formatResetDelta,
	windowLabel,
	worstWindow,
} from "../../shared/rate-limits";

/** Data older than this gets a staleness note in the tooltip. */
const STALE_AFTER_MS = 10 * 60 * 1000;

const SOURCE_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/**
 * Ambient agent rate-limit indicator (global header, stateful-indicators zone).
 * Passive "battery gauge" for the account-wide Claude/Codex limit windows so a
 * dev running many parallel agents is never blindsided by hitting a limit.
 * Hidden until any data exists; escalates color at ≥80% / ≥95% of the most
 * constrained window. Details (per-window % + time-to-reset) live in the
 * tooltip. Data comes from local files only — see rate-limit-monitor.ts.
 */
function RateLimitIndicator({ compact = false }: { compact?: boolean }) {
	const t = useT();
	const [report, setReport] = useState<AgentRateLimitsReport | null>(null);

	useEffect(() => {
		api.request.getAgentRateLimits().then(setReport).catch(() => {
			// backend not ready — stay hidden until the first push arrives
		});
		function onUpdate(e: Event) {
			setReport((e as CustomEvent).detail as AgentRateLimitsReport);
		}
		window.addEventListener("rpc:agentRateLimitsUpdated", onUpdate);
		return () => window.removeEventListener("rpc:agentRateLimitsUpdated", onUpdate);
	}, []);

	const worst = report ? worstWindow(report) : null;
	if (!report || !worst) return null;

	const now = Date.now();
	const percent = Math.round(worst.window.usedPercent);
	const danger = percent >= RATE_LIMIT_DANGER_PERCENT;
	const warn = !danger && percent >= RATE_LIMIT_WARN_PERCENT;

	const rows: string[] = [];
	let staleCapturedAt: number | null = null;
	for (const snap of report.snapshots) {
		const sourceName = SOURCE_NAMES[snap.source] ?? snap.source;
		for (const win of snap.windows) {
			const reset = formatResetDelta(win.resetsAt, now);
			rows.push(
				`${sourceName} ${windowLabel(win)} — ${Math.round(win.usedPercent)}%${reset ? ` · ${t("rateLimits.resetsIn", { time: reset })}` : ""}`,
			);
		}
		if (snap.creditsBalance != null) {
			rows.push(`${sourceName} — ${t("rateLimits.credits", { balance: snap.creditsBalance })}`);
		}
		if (now - snap.capturedAt > STALE_AFTER_MS && (staleCapturedAt == null || snap.capturedAt < staleCapturedAt)) {
			staleCapturedAt = snap.capturedAt;
		}
	}

	const worstReset = formatResetDelta(worst.window.resetsAt, now);
	const ariaLabel = `${t("rateLimits.tooltipTitle")}: ${SOURCE_NAMES[worst.source] ?? worst.source} ${windowLabel(worst.window)} ${percent}%${worstReset ? `, ${t("rateLimits.resetsIn", { time: worstReset })}` : ""}`;

	const colorClasses = danger
		? "text-danger bg-danger/15 border-danger/30"
		: warn
			? "text-warning bg-warning/15 border-warning/30"
			: "text-fg-3 border-transparent";

	return (
		<Tooltip
			content={t("rateLimits.tooltipTitle")}
			detail={
				<div className="flex flex-col gap-0.5">
					{rows.map((row) => (
						<span key={row}>{row}</span>
					))}
					{staleCapturedAt != null && (
						<span className="text-fg-muted">
							{t("rateLimits.stale", { time: formatAge(now - staleCapturedAt) })}
						</span>
					)}
				</div>
			}
		>
			<div
				role="status"
				aria-label={ariaLabel}
				data-help-id="header.rateLimits"
				className={`header-anim flex select-none items-center gap-1 px-1.5 py-1 rounded-lg border transition-colors ${colorClasses}`}
			>
				<span
					className="text-[1.125rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F029A}"}
				</span>
				{!compact && <span className="text-[0.6875rem] font-medium tabular-nums">{percent}%</span>}
			</div>
		</Tooltip>
	);
}

/** Compact age like "12m" or "3h" for the staleness note. */
function formatAge(ms: number): string {
	const mins = Math.round(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export default RateLimitIndicator;
