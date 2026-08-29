import type { ReactNode } from "react";
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
	if (percent >= RATE_LIMIT_WARN_PERCENT) return "text-warning-strong";
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

/**
 * One limit window as a single dense line: `label · bar · % · reset`, the same
 * grammar the launch account picker uses. It replaced a two-line "text over a
 * full-width bar" block — two windows plus a provenance line made every account
 * card ~90px tall, so a handful of accounts could not be compared without
 * scrolling the panel.
 */
export function WindowBarRow({
	label,
	usedPercent,
	resetsAt,
	now,
	detail,
	trailing,
}: {
	label: string;
	usedPercent: number;
	resetsAt: number | null;
	now: number;
	detail?: string;
	/** Rides the last line of a card (capture age), instead of its own line. */
	trailing?: ReactNode;
}) {
	const t = useT();
	const percent = Math.round(usedPercent);
	const reset = formatResetDelta(resetsAt, now);
	return (
		<div className="flex flex-col gap-[0.1875rem]">
			<div className="flex items-center gap-1.5">
				<span className="min-w-[1.5rem] shrink-0 font-medium tabular-nums text-fg-3">{label}</span>
				<UsageBar percent={usedPercent} className="h-1 min-w-[3rem] flex-1" />
				<span className="shrink-0 whitespace-nowrap tabular-nums">
					<span className={`font-semibold ${severityText(percent)}`}>{t("rateLimits.percentUsed", { percent })}</span>
					{reset && <span className="text-fg-3"> · {t("rateLimits.resetsIn", { time: reset })}</span>}
					{trailing}
				</span>
			</div>
			{detail && <span className="text-fg-muted">{detail}</span>}
		</div>
	);
}

/** Shared card chrome, so surfaces that have an account but no usage reading
 *  (the usage panel) render an identical-looking card. `items-stretch` is not
 *  redundant: WebKit's UA stylesheet centres a <button>'s flex children, which
 *  shrank every usage bar inside one to its own text width. */
export const ACCOUNT_CARD_CLASS =
	"flex flex-col items-stretch gap-1 rounded-md border border-edge bg-raised/65 px-2 py-1";

/** Card headline: provider name, account identity, plan/API chips. */
export function AccountCardHeader({
	source,
	account,
	unlimited,
}: {
	source: RateLimitSource;
	account: AccountLine | null;
	unlimited?: boolean;
}) {
	const t = useT();
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
		<div className="flex items-center gap-1.5">
			<span className="text-fg-2 font-medium shrink-0">{SOURCE_NAMES[source] ?? source}</span>
			{displayName && <span className="min-w-0 truncate text-fg-3 streamer-private">{displayName}</span>}
			{/* The workspace shrinks too. Held at its natural width it pushed the plan
			    and "Default" chips off the panel's right edge instead of eliding. */}
			{showOrg && <span className="min-w-0 truncate text-fg-muted streamer-private">· {account?.organization}</span>}
			{account?.planLabel && (
				<span className="text-accent text-micro px-1 py-px bg-accent/10 rounded shrink-0">{account.planLabel}</span>
			)}
			{/* API is an auth kind, not a warning — neutral chip, same as the workspace chip. */}
			{account?.isApi && <span className="text-fg-3 text-micro px-1 py-px bg-raised rounded shrink-0">API</span>}
			{unlimited && (
				<span className="ml-auto text-success-strong text-micro px-1 py-px bg-success/10 rounded shrink-0 font-medium">
					{t("rateLimits.unlimited")}
				</span>
			)}
		</div>
	);
}

/** Every usage bar of one account: limit windows, monthly credits, provenance.
 *  Split out of AccountCard so the usage modal can wrap the same bars in a
 *  selectable row without re-implementing them. */
export function AccountQuotaLines({ snap, now }: { snap: AgentRateLimitSnapshot; now: number }) {
	const t = useT();
	const [locale] = useLocale();
	const unlimited = isUnlimitedRateLimitSnapshot(snap);
	const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
	const monthly = snap.monthlyCredits;
	// The monthly_credits window mirrors snap.monthlyCredits; the dedicated row
	// below renders it with its used/limit detail, so skip the duplicate here.
	const windows = snap.windows.filter((w: RateLimitWindow) => !(w.id === "monthly_credits" && monthly));
	// Provenance rides the last quota line as a "· 15h" suffix. On its own line it
	// cost every card a full row for four characters.
	const age = <CapturedAgeSuffix capturedAt={snap.capturedAt} now={now} />;
	const lastWindowIndex = monthly ? -1 : windows.length - 1;
	return (
		<>
			{windows.map((win, index) => (
				<WindowBarRow
					key={win.id}
					label={windowLabel(win)}
					usedPercent={win.usedPercent}
					resetsAt={win.resetsAt}
					now={now}
					trailing={index === lastWindowIndex ? age : undefined}
				/>
			))}
			{monthly && (
				<WindowBarRow
					label={t("rateLimits.monthlyLabel")}
					usedPercent={Math.max(0, 100 - monthly.remainingPercent)}
					resetsAt={monthly.resetsAt}
					now={now}
					trailing={age}
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
		</>
	);
}

/** Whether a reading has anything to plot. An unlimited account has no window
 *  at all, so its card is a headline only — and its capture age has to ride
 *  that headline rather than dangle on a line of its own. */
export function hasQuotaLines(snap: AgentRateLimitSnapshot): boolean {
	if (snap.monthlyCredits || snap.windows.length > 0) return true;
	return snap.creditsBalance != null && !isUnlimitedRateLimitSnapshot(snap);
}

/**
 * Capture age as a dense inline suffix ("· 15h") for surfaces that cannot spend
 * a whole line on provenance. Same honesty contract as CapturedNote: warning
 * tint past STALE_AFTER_MS so a reading from days ago never reads as live.
 */
export function CapturedAgeSuffix({ capturedAt, now }: { capturedAt: number; now: number }) {
	const t = useT();
	const age = Math.max(0, now - capturedAt);
	const stale = age > STALE_AFTER_MS;
	const short = age < 60_000 ? t("rateLimits.capturedAgeNow") : formatAge(age);
	const full = age < 60_000 ? t("rateLimits.capturedNow") : t("rateLimits.captured", { time: formatAge(age) });
	return (
		<span title={full} className={stale ? "text-warning-strong" : "text-fg-3"}>
			{" · "}
			{short}
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
