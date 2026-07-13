import { useEffect, useState } from "react";
import { api } from "../rpc";
import { useLocale, useT } from "../i18n";
import Tooltip from "./Tooltip";
import { RateLimitIcon } from "./HeaderIcons";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport, RateLimitSource } from "../../shared/rate-limits";
import {
	RATE_LIMIT_DANGER_PERCENT,
	RATE_LIMIT_WARN_PERCENT,
	formatResetDelta,
	windowLabel,
	worstWindow,
} from "../../shared/rate-limits";
import type { AgentAccountsState } from "../../shared/agent-accounts";
import { AGENT_ACCOUNTS_CHANGED_EVENT } from "./AgentAccountIndicator";

/** Data older than this gets a staleness note in the tooltip. */
const STALE_AFTER_MS = 10 * 60 * 1000;

const SOURCE_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** Which account the rate-limit windows for a source are drawn from. */
interface AccountLine {
	/** Email / user-set label of the active account (null when identity unknown). */
	name: string | null;
	/** Login email, when known — used to collapse the auto-generated
	 *  "email (workspace)" label into a consistent "email · workspace" row. */
	email: string | null;
	/** Organization / workspace name, when known. Disambiguates two accounts that
	 *  share the same login email but live in different workspaces. */
	organization: string | null;
	/** Plan/tier badge (e.g. "Max 5x", "Plus"), when known. */
	planLabel: string | null;
	/** Active account is an API/custom-endpoint profile rather than an OAuth login. */
	isApi: boolean;
}

/**
 * Resolve the active account behind a source's limits from the account switcher
 * state: the active managed account, else the system/current login identity.
 * The rate-limit windows always reflect whichever account launched the session,
 * so surfacing it answers "whose limit is this?" at a glance.
 */
function resolveAccount(source: RateLimitSource, state: AgentAccountsState | null): AccountLine | null {
	if (!state) return null;
	const kindState = state[source];
	const active = kindState.accounts.find((a) => a.id === kindState.activeId) ?? null;
	if (active) {
		return {
			name: active.label,
			email: active.auth === "api" ? null : (active.identity?.email ?? null),
			organization: active.auth === "api" ? null : (active.identity?.organization ?? null),
			planLabel: active.auth === "api" ? null : (active.identity?.planLabel ?? null),
			isApi: active.auth === "api",
		};
	}
	const fallback = source === "claude" ? state.claude.systemIdentity : state.codex.currentIdentity;
	if (fallback) {
		return {
			name: fallback.email,
			email: fallback.email,
			organization: fallback.organization,
			planLabel: fallback.planLabel,
			isApi: false,
		};
	}
	return null;
}

/** Build the detail rows (windows + credits + monthly usage) for one snapshot. */
function snapshotRows(
	snap: AgentRateLimitSnapshot,
	now: number,
	t: ReturnType<typeof useT>,
	locale: string,
): string[] {
	const rows: string[] = [];
	for (const win of snap.windows) {
		if (win.id === "monthly_credits") continue;
		const reset = formatResetDelta(win.resetsAt, now);
		rows.push(
			`${windowLabel(win)} — ${t("rateLimits.percentUsed", { percent: Math.round(win.usedPercent) })}${reset ? ` · ${t("rateLimits.resetsIn", { time: reset })}` : ""}`,
		);
	}
	if (snap.creditsBalance != null) {
		rows.push(t("rateLimits.credits", { balance: snap.creditsBalance }));
	}
	if (snap.monthlyCredits) {
		const monthly = snap.monthlyCredits;
		const reset = formatResetDelta(monthly.resetsAt, now);
		const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
		rows.push(
			`${t("rateLimits.monthlyLabel")} — ${t("rateLimits.monthlyUsage", {
				used: numberFormat.format(monthly.used),
				limit: numberFormat.format(monthly.limit),
				remaining: Math.round(monthly.remainingPercent),
			})}${reset ? ` · ${t("rateLimits.resetsIn", { time: reset })}` : ""}`,
		);
	}
	return rows;
}

/**
 * Ambient agent rate-limit indicator (global header, stateful-indicators zone).
 * Passive "battery gauge" for the account-wide Claude/Codex limit windows so a
 * dev running many parallel agents is never blindsided by hitting a limit.
 * Hidden until any data exists; escalates color at ≥80% / ≥95% of the most
 * constrained window. Details (per-window % + time-to-reset) live in the
 * tooltip. Codex monthly credits come from a cached app-server account read;
 * all other data comes from local files — see rate-limit-monitor.ts.
 */
function RateLimitIndicator({ compact = false }: { compact?: boolean }) {
	const t = useT();
	const [locale] = useLocale();
	const [report, setReport] = useState<AgentRateLimitsReport | null>(null);
	const [accounts, setAccounts] = useState<AgentAccountsState | null>(null);

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

	useEffect(() => {
		function reload() {
			api.request
				.listAgentAccounts()
				.then(setAccounts)
				.catch(() => {
					// switcher unavailable — the tooltip just omits the account line
				});
		}
		reload();
		// An account switch elsewhere changes which login these limits belong to.
		window.addEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, reload);
		return () => window.removeEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, reload);
	}, []);

	const worst = report ? worstWindow(report) : null;
	if (!report || !worst) return null;

	const now = Date.now();
	const percent = Math.round(worst.window.usedPercent);
	const danger = percent >= RATE_LIMIT_DANGER_PERCENT;
	const warn = !danger && percent >= RATE_LIMIT_WARN_PERCENT;

	let staleCapturedAt: number | null = null;
	for (const snap of report.snapshots) {
		if (now - snap.capturedAt > STALE_AFTER_MS && (staleCapturedAt == null || snap.capturedAt < staleCapturedAt)) {
			staleCapturedAt = snap.capturedAt;
		}
	}

	const worstReset = formatResetDelta(worst.window.resetsAt, now);
	const worstLabel = worst.window.id === "monthly_credits" ? t("rateLimits.monthlyLabel") : windowLabel(worst.window);
	const ariaLabel = `${t("rateLimits.tooltipTitle")}: ${SOURCE_NAMES[worst.source] ?? worst.source} ${worstLabel} ${t("rateLimits.percentUsed", { percent })}${worstReset ? `, ${t("rateLimits.resetsIn", { time: worstReset })}` : ""}`;

	const colorClasses = danger
		? "text-danger bg-danger/15 border-danger/30"
		: warn
			? "text-warning bg-warning/15 border-warning/30"
			: "text-fg-3 border-transparent";

	return (
		<Tooltip
			content={t("rateLimits.tooltipTitle")}
			wide
			detail={
				<div className="flex flex-col gap-2">
					{report.snapshots.map((snap) => {
						const account = resolveAccount(snap.source, accounts);
						const rows = snapshotRows(snap, now, t, locale);
						// Collapse the auto-generated "email (workspace)" label into a plain
						// email so every row reads consistently as "email · workspace" (the
						// chip carries the workspace). A user-custom label is left untouched.
						const displayName =
							account?.email && account.organization && account.name === `${account.email} (${account.organization})`
								? account.email
								: (account?.name ?? null);
						const showOrg =
							!!account?.organization &&
							account.organization !== displayName &&
							!(displayName ?? "").endsWith(`(${account.organization})`);
						return (
							<div key={snap.source} className="flex flex-col gap-0.5">
								<div className="flex items-center gap-1.5">
									<span className="text-fg-2 font-medium shrink-0">{SOURCE_NAMES[snap.source] ?? snap.source}</span>
									{displayName && <span className="text-fg-3">{displayName}</span>}
									{showOrg && (
										<span className="text-fg-muted whitespace-nowrap shrink-0">· {account?.organization}</span>
									)}
									{account?.planLabel && (
										<span className="text-accent text-[0.625rem] px-1 py-px bg-accent/10 rounded">
											{account.planLabel}
										</span>
									)}
									{account?.isApi && (
										<span className="text-warning text-[0.625rem] px-1 py-px bg-warning/10 rounded">API</span>
									)}
								</div>
								{rows.map((row) => (
									<span key={row} className="text-fg-3 pl-0.5">
										{row}
									</span>
								))}
							</div>
						);
					})}
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
				tabIndex={0}
				aria-label={ariaLabel}
				data-help-id="header.rateLimits"
				className={`header-anim flex cursor-pointer select-none items-center gap-1 px-1.5 py-1 rounded-lg border transition-colors ${colorClasses}`}
			>
				<RateLimitIcon className="w-[1.125rem] h-[1.125rem]" />
				{!compact && (
					<span className="text-[0.6875rem] font-medium tabular-nums">
						{percent}%<span className="ml-0.5 text-[0.5625rem] font-normal opacity-70">{t("rateLimits.used")}</span>
					</span>
				)}
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
