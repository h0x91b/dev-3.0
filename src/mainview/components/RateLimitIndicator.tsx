import { useEffect, useState } from "react";
import { api } from "../rpc";
import { useLocale, useT } from "../i18n";
import Tooltip from "./Tooltip";
import { RateLimitIcon } from "./HeaderIcons";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport, RateLimitSource, RateLimitWindow } from "../../shared/rate-limits";
import {
	RATE_LIMIT_DANGER_PERCENT,
	RATE_LIMIT_WARN_PERCENT,
	formatResetDelta,
	isUnlimitedRateLimitSnapshot,
	latestRateLimitSnapshot,
	windowLabel,
	worstSnapshotWindow,
} from "../../shared/rate-limits";
import type { AgentAccountsState } from "../../shared/agent-accounts";
import { AGENT_ACCOUNTS_CHANGED_EVENT } from "./AgentAccountIndicator";

/** Data older than this gets a staleness note in the tooltip. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** The pill stacks one mini bar per account, capped to keep the header slim. */
const MAX_PILL_BARS = 4;

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
function resolveAccount(source: RateLimitSource, state: AgentAccountsState | null, accountId?: string | null): AccountLine | null {
	if (!state) return null;
	const kindState = state[source];
	const active =
		accountId === undefined
			? (kindState.accounts.find((a) => a.id === kindState.activeId) ?? null)
			: accountId
				? (kindState.accounts.find((a) => a.id === accountId) ?? null)
				: null;
	if (active) {
		return {
			name: active.label,
			email: active.auth === "api" ? null : (active.identity?.email ?? null),
			organization: active.auth === "api" ? null : (active.identity?.organization ?? null),
			planLabel: active.auth === "api" ? null : (active.identity?.planLabel ?? null),
			isApi: active.auth === "api",
		};
	}
	// An attributed managed snapshot must never fall back to the default account
	// when that account was removed or is still loading; that would mislabel the
	// usage row. Null explicitly means the provider's system login.
	if (accountId !== undefined && accountId !== null) return null;
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

function severityFill(percent: number): string {
	if (percent >= RATE_LIMIT_DANGER_PERCENT) return "bg-danger";
	if (percent >= RATE_LIMIT_WARN_PERCENT) return "bg-warning";
	return "bg-accent";
}

function severityText(percent: number): string {
	if (percent >= RATE_LIMIT_DANGER_PERCENT) return "text-danger";
	if (percent >= RATE_LIMIT_WARN_PERCENT) return "text-warning";
	return "text-fg-2";
}

/** Horizontal usage gauge: track + severity-colored fill, clamped to 0–100. */
function UsageBar({ percent, className }: { percent: number; className: string }) {
	const clamped = Math.max(0, Math.min(100, percent));
	return (
		<span aria-hidden="true" className={`relative block overflow-hidden rounded-full bg-fg/10 ${className}`}>
			<span
				className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${severityFill(percent)}`}
				style={{ width: `${clamped}%`, minWidth: clamped > 0 ? "0.3rem" : undefined }}
			/>
		</span>
	);
}

/** One limit window inside an account card: label + reset + percent over a bar. */
function WindowBarRow({
	label,
	usedPercent,
	resetsAt,
	now,
	detail,
}: {
	label: string;
	usedPercent: number;
	resetsAt: number | null;
	now: number;
	detail?: string;
}) {
	const t = useT();
	const percent = Math.round(usedPercent);
	const reset = formatResetDelta(resetsAt, now);
	return (
		<div className="flex flex-col gap-[0.1875rem]">
			<div className="flex items-baseline gap-2">
				<span className="min-w-0 truncate font-medium text-fg-3">{label}</span>
				{reset && <span className="ml-auto shrink-0 text-fg-muted">{t("rateLimits.resetsIn", { time: reset })}</span>}
				<span className={`shrink-0 font-medium tabular-nums ${reset ? "" : "ml-auto"} ${severityText(percent)}`}>
					{t("rateLimits.percentUsed", { percent })}
				</span>
			</div>
			<UsageBar percent={usedPercent} className="h-1.5 w-full" />
			{detail && <span className="text-fg-muted">{detail}</span>}
		</div>
	);
}

/** One account's quota card: identity header + a bar per limit window. */
function AccountCard({
	snap,
	account,
	now,
}: {
	snap: AgentRateLimitSnapshot;
	account: AccountLine | null;
	now: number;
}) {
	const t = useT();
	const [locale] = useLocale();
	const unlimited = isUnlimitedRateLimitSnapshot(snap);
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

	const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
	const monthly = snap.monthlyCredits;
	// The monthly_credits window mirrors snap.monthlyCredits; the dedicated row
	// below renders it with its used/limit detail, so skip the duplicate here.
	const windows = snap.windows.filter((w: RateLimitWindow) => !(w.id === "monthly_credits" && monthly));

	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-edge bg-raised/65 px-2.5 py-2">
			<div className="flex items-center gap-1.5">
				<span className="text-fg-2 font-medium shrink-0">{SOURCE_NAMES[snap.source] ?? snap.source}</span>
				{displayName && <span className="min-w-0 truncate text-fg-3">{displayName}</span>}
				{showOrg && <span className="text-fg-muted whitespace-nowrap shrink-0">· {account?.organization}</span>}
				{account?.planLabel && (
					<span className="text-accent text-[0.625rem] px-1 py-px bg-accent/10 rounded shrink-0">{account.planLabel}</span>
				)}
				{account?.isApi && <span className="text-warning text-[0.625rem] px-1 py-px bg-warning/10 rounded shrink-0">API</span>}
				{unlimited && (
					<span className="ml-auto text-success text-[0.625rem] px-1 py-px bg-success/10 rounded shrink-0 font-medium">
						{t("rateLimits.unlimited")}
					</span>
				)}
			</div>
			{windows.map((win) => (
				<WindowBarRow key={win.id} label={windowLabel(win)} usedPercent={win.usedPercent} resetsAt={win.resetsAt} now={now} />
			))}
			{monthly && (
				<WindowBarRow
					label={t("rateLimits.monthlyLabel")}
					usedPercent={Math.max(0, 100 - monthly.remainingPercent)}
					resetsAt={monthly.resetsAt}
					now={now}
					detail={t("rateLimits.monthlyUsage", {
						used: numberFormat.format(monthly.used),
						limit: numberFormat.format(monthly.limit),
						remaining: Math.round(monthly.remainingPercent),
					})}
				/>
			)}
			{snap.creditsBalance != null && !unlimited && (
				<span className="text-fg-3">{t("rateLimits.credits", { balance: snap.creditsBalance })}</span>
			)}
		</div>
	);
}

/**
 * Ambient agent rate-limit indicator (global header, stateful-indicators zone).
 * Passive "battery gauge" for the account-wide Claude/Codex limit windows so a
 * dev running many parallel agents is never blindsided by hitting a limit.
 * Hidden until usable data exists; shows the most constrained window for the
 * most recently active account and treats unlimited credits as 0% used.
 * Details for every recently active account live in the tooltip as per-account
 * quota cards with usage bars. Codex monthly credits come from a cached
 * app-server account read; all other data comes from local files — see
 * rate-limit-monitor.ts.
 */
function RateLimitIndicator({ compact = false }: { compact?: boolean }) {
	const t = useT();
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

	const latestSnapshot = report ? latestRateLimitSnapshot(report) : null;
	const latestWindow = latestSnapshot ? worstSnapshotWindow(latestSnapshot) : null;
	const unlimited = latestSnapshot ? isUnlimitedRateLimitSnapshot(latestSnapshot) : false;
	if (!report || !latestSnapshot || (!latestWindow && !unlimited)) return null;

	const now = Date.now();
	const percent = latestWindow && !unlimited ? Math.round(latestWindow.usedPercent) : 0;
	const danger = percent >= RATE_LIMIT_DANGER_PERCENT;
	const warn = !danger && percent >= RATE_LIMIT_WARN_PERCENT;

	let staleCapturedAt: number | null = null;
	for (const snap of report.snapshots) {
		if (now - snap.capturedAt > STALE_AFTER_MS && (staleCapturedAt == null || snap.capturedAt < staleCapturedAt)) {
			staleCapturedAt = snap.capturedAt;
		}
	}

	const latestReset = formatResetDelta(latestWindow?.resetsAt ?? null, now);
	const latestLabel = latestWindow
		? latestWindow.id === "monthly_credits"
			? t("rateLimits.monthlyLabel")
			: windowLabel(latestWindow)
		: null;
	const ariaLabel = unlimited
		? `${t("rateLimits.tooltipTitle")}: ${SOURCE_NAMES[latestSnapshot.source] ?? latestSnapshot.source} ${t("rateLimits.unlimited")}`
		: `${t("rateLimits.tooltipTitle")}: ${SOURCE_NAMES[latestSnapshot.source] ?? latestSnapshot.source}${latestLabel ? ` ${latestLabel}` : ""} ${t("rateLimits.percentUsed", { percent })}${latestReset ? `, ${t("rateLimits.resetsIn", { time: latestReset })}` : ""}`;

	const pillSnapshots = report.snapshots.slice(0, MAX_PILL_BARS);

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
				<div className="flex w-[24rem] max-w-[calc(100vw-3rem)] flex-col gap-1.5">
					{report.snapshots.map((snap) => (
						<AccountCard
							key={`${snap.source}:${snap.accountId ?? "system"}`}
							snap={snap}
							account={resolveAccount(snap.source, accounts, snap.accountId)}
							now={now}
						/>
					))}
					{staleCapturedAt != null && (
						<span className="text-fg-muted">{t("rateLimits.stale", { time: formatAge(now - staleCapturedAt) })}</span>
					)}
				</div>
			}
		>
			<div
				role="status"
				tabIndex={0}
				aria-label={ariaLabel}
				data-help-id="header.rateLimits"
				className={`header-anim flex cursor-pointer select-none items-center gap-1.5 px-1.5 py-1 rounded-lg border transition-colors ${colorClasses}`}
			>
				<RateLimitIcon className="w-[1.125rem] h-[1.125rem]" />
				{!compact && (
					<>
						{/* One mini bar per recently active account, top-to-bottom in the
						    same order as the tooltip cards. Unlimited accounts render a
						    full success bar (matching the ∞ chip) instead of a fake 0%. */}
						<span aria-hidden="true" className="flex w-7 shrink-0 flex-col gap-[0.0625rem]">
							{pillSnapshots.map((snap) => {
								const snapUnlimited = isUnlimitedRateLimitSnapshot(snap);
								const snapPercent = snapUnlimited ? 100 : Math.round(worstSnapshotWindow(snap)?.usedPercent ?? 0);
								const clamped = Math.max(0, Math.min(100, snapPercent));
								return (
									<span
										key={`${snap.source}:${snap.accountId ?? "system"}`}
										className={`relative block w-full overflow-hidden rounded-full bg-fg/15 ${pillSnapshots.length > 1 ? "h-[0.125rem]" : "h-[0.1875rem]"}`}
									>
										<span
											className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${snapUnlimited ? "bg-success" : severityFill(snapPercent)}`}
											style={{ width: `${clamped}%`, minWidth: clamped > 0 ? "0.125rem" : undefined }}
										/>
									</span>
								);
							})}
						</span>
						<span className="text-[0.6875rem] font-medium tabular-nums">
							{unlimited ? (
								t("rateLimits.unlimited")
							) : (
								<>
									{percent}%<span className="ml-0.5 text-[0.5625rem] font-normal opacity-70">{t("rateLimits.used")}</span>
								</>
							)}
						</span>
					</>
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
