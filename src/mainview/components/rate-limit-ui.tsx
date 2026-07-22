import { useLocale, useT } from "../i18n";
import type { AgentRateLimitSnapshot, RateLimitSource, RateLimitWindow } from "../../shared/rate-limits";
import {
	RATE_LIMIT_DANGER_PERCENT,
	RATE_LIMIT_WARN_PERCENT,
	formatResetDelta,
	isUnlimitedRateLimitSnapshot,
	windowLabel,
} from "../../shared/rate-limits";
import type { AgentAccountsState } from "../../shared/agent-accounts";

/**
 * Shared rate-limit presentation pieces, used by the header RateLimitIndicator
 * (quota panel) and the account switcher popover (per-row usage rings). Lives
 * in its own module so the two indicators can share without importing each
 * other (AgentAccountIndicator ↔ RateLimitIndicator would be a cycle).
 */

/** Data older than this gets a staleness note in the tooltip. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export const SOURCE_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** Which account the rate-limit windows for a source are drawn from. */
export interface AccountLine {
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
export function resolveAccount(
	source: RateLimitSource,
	state: AgentAccountsState | null,
	accountId?: string | null,
): AccountLine | null {
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

export function severityFill(percent: number): string {
	if (percent >= RATE_LIMIT_DANGER_PERCENT) return "bg-danger";
	if (percent >= RATE_LIMIT_WARN_PERCENT) return "bg-warning";
	return "bg-accent";
}

export function severityText(percent: number): string {
	if (percent >= RATE_LIMIT_DANGER_PERCENT) return "text-danger";
	if (percent >= RATE_LIMIT_WARN_PERCENT) return "text-warning";
	return "text-fg-2";
}

/** Horizontal usage gauge: track + severity-colored fill, clamped to 0–100. */
export function UsageBar({ percent, className }: { percent: number; className: string }) {
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
export function WindowBarRow({
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
export function AccountCard({
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
			<CapturedNote capturedAt={snap.capturedAt} now={now} />
		</div>
	);
}

/**
 * Per-card provenance line: how long ago this account's rate-limit reading was
 * captured. Data is only refreshed while a session for that account is active,
 * so anything beyond a few minutes may be stale — flagged in the warning tint
 * once past STALE_AFTER_MS so a reading from days ago never reads as live.
 */
export function CapturedNote({ capturedAt, now }: { capturedAt: number; now: number }) {
	const t = useT();
	const age = Math.max(0, now - capturedAt);
	const stale = age > STALE_AFTER_MS;
	const label = age < 60_000 ? t("rateLimits.capturedNow") : t("rateLimits.captured", { time: formatAge(age) });
	return (
		<span className={`flex items-center gap-1 text-[0.625rem] ${stale ? "text-warning" : "text-fg-muted"}`}>
			{label}
		</span>
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
