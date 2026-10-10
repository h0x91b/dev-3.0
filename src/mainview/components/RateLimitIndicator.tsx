import { useEffect, useState } from "react";
import { api } from "../rpc";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { useT } from "../i18n";
import { useAgentRateLimitsReport } from "../hooks/useAgentRateLimitsReport";
import { useHeaderFlyout } from "../hooks/useHeaderFlyout";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import BottomSheet from "./BottomSheet";
import HeaderFlyoutPanel from "./HeaderFlyoutPanel";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import {
	RATE_LIMIT_DANGER_PERCENT,
	RATE_LIMIT_WARN_PERCENT,
	formatResetDelta,
	headerPillWindows,
	isUnlimitedRateLimitSnapshot,
	latestRateLimitSnapshot,
	scopeRateLimitSnapshots,
	windowLabel,
	worstSnapshotWindow,
} from "../../shared/rate-limits";
import type { AgentAccountsState } from "../../shared/agent-accounts";
import { AGENT_ACCOUNTS_CHANGED_EVENT, useClaudeLoginScope, usePinnedClaudeLogins } from "./AgentAccountIndicator";
import { SOURCE_NAMES, severityFill } from "./rate-limit-ui";
import AgentUsagePanel from "./AgentUsagePanel";

/** Panel width in px — wide enough for a "label · bar · % · reset" line. */
const PANEL_WIDTH = 26 * 16;

/**
 * Ambient agent rate-limit indicator (global header, stateful-indicators zone).
 * "Battery gauge" for the account-wide Claude/Codex limit windows so a
 * dev running many parallel agents is never blindsided by hitting a limit.
 * Hidden until usable data exists; shows the most constrained window for the
 * most recently active account and treats unlimited credits as 0% used.
 * Hovering drops its panel below the pill — read-only while it is merely
 * hovered. A click PINS it, and only then do its per-account cards become the
 * settings screen's radio control for the default account: a durable setting
 * must not be one stray click away from a panel the pointer passed through.
 * Codex monthly credits come from a cached app-server account read; all other
 * data comes from local files — see rate-limit-monitor.ts.
 * Inside a project only that project's Claude login and its tasks' sessions
 * count; with none in scope (dashboard, settings) every login and session does.
 */
function RateLimitIndicator({
	compact = false,
	projectId = null,
	onOpenSessions,
}: {
	compact?: boolean;
	projectId?: string | null;
	onOpenSessions?: () => void;
}) {
	const t = useT();
	const report = useAgentRateLimitsReport();
	const [accounts, setAccounts] = useState<AgentAccountsState | null>(null);
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	// Same open/pin/position machinery as the memory-headroom readout: hover drops
	// the panel below the pill, a click pins it — and pinned is what unlocks its rows.
	const flyout = useHeaderFlyout({ variant: "bar", isNarrow, repositionKey: report });
	// Re-read on every open: a project's pin lives in its config files, which
	// change without any push.
	const pinnedLogins = usePinnedClaudeLogins(flyout.open);

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

	// Re-resolved on every open, like the pinned logins: the pin lives in config files.
	const scope = useClaudeLoginScope(projectId, accounts, flyout.open);
	const scoped: AgentRateLimitsReport | null = report
		? { ...report, snapshots: scopeRateLimitSnapshots(report.snapshots, scope) }
		: null;
	const latestSnapshot = scoped ? latestRateLimitSnapshot(scoped) : null;
	const latestWindow = latestSnapshot ? worstSnapshotWindow(latestSnapshot) : null;
	const unlimited = latestSnapshot ? isUnlimitedRateLimitSnapshot(latestSnapshot) : false;
	if (!scoped || !latestSnapshot || (!latestWindow && !unlimited)) return null;

	const now = Date.now();
	const percent = latestWindow && !unlimited ? Math.round(latestWindow.usedPercent) : 0;
	const danger = percent >= RATE_LIMIT_DANGER_PERCENT;
	const warn = !danger && percent >= RATE_LIMIT_WARN_PERCENT;

	const latestReset = formatResetDelta(latestWindow?.resetsAt ?? null, now);
	const labelOf = (w: NonNullable<typeof latestWindow>) =>
		w.id === "monthly_credits" ? t("rateLimits.monthlyLabel") : windowLabel(w);
	const latestLabel = latestWindow ? labelOf(latestWindow) : null;
	// Every window spelled out: the 5h one tracks the session, the 7d one the week.
	// The colour still follows the fullest, so a red week cannot hide behind the hour.
	const pillWindows = headerPillWindows(latestSnapshot);
	const ariaLabel = unlimited
		? `${t("rateLimits.panelTitle")}: ${SOURCE_NAMES[latestSnapshot.source] ?? latestSnapshot.source} ${t("rateLimits.unlimited")}`
		: `${t("rateLimits.panelTitle")}: ${SOURCE_NAMES[latestSnapshot.source] ?? latestSnapshot.source}${latestLabel ? ` ${latestLabel}` : ""} ${t("rateLimits.percentUsed", { percent })}${latestReset ? `, ${t("rateLimits.resetsIn", { time: latestReset })}` : ""}`;
	const interactiveAriaLabel = `${ariaLabel}. ${t("rateLimits.openAccounts")}`;


	const colorClasses = danger
		? "text-danger bg-danger/15 border-danger/30"
		: warn
			? "text-warning-strong bg-warning/15 border-warning/30"
			: "text-fg-3 border-transparent";

	const openAccountsSettings = () => {
		window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: "accounts" }));
	};

	const panel = (
		<AgentUsagePanel
			report={scoped}
			accounts={accounts}
			pinnedLogins={scope ? pinnedLogins.filter((login) => login.configDir === scope.configDir) : pinnedLogins}
			projectPinned={!!scope?.configDir}
			projectId={projectId}
			// A sheet is opened deliberately and has no hover state to pass through;
			// the desktop flyout has to be pinned first.
			interactive={isNarrow || flyout.pinned}
			onOpenSettings={() => {
				flyout.close();
				openAccountsSettings();
			}}
			onOpenSessions={
				onOpenSessions &&
				(() => {
					flyout.close();
					onOpenSessions();
				})
			}
		/>
	);

	return (
		<>
			<button
				ref={flyout.anchorRef}
				type="button"
				aria-label={interactiveAriaLabel}
				data-help-id="header.rateLimits"
				className={`header-anim flex cursor-pointer select-none items-center gap-1.5 px-1.5 py-1 rounded-lg border transition-colors ${colorClasses}`}
				{...flyout.triggerProps}
			>
				{/* One mini bar per window the text spells out (5h on top, then 7d),
				    each filled to its own usage. An unlimited account renders one full
				    success bar (matching the ∞ chip) instead of a fake 0%. In compact
				    mode the bars ARE the whole pill. */}
				<span aria-hidden="true" className="flex w-7 shrink-0 flex-col gap-[0.0625rem]">
					{(unlimited ? [null] : pillWindows).map((w) => {
						const barPercent = w ? Math.round(w.usedPercent) : 100;
						const clamped = Math.max(0, Math.min(100, barPercent));
						return (
							<span
								key={w?.id ?? "unlimited"}
								className={`relative block w-full overflow-hidden rounded-full bg-fg/15 ${pillWindows.length > 1 && !unlimited ? "h-[0.125rem]" : "h-[0.1875rem]"}`}
							>
								<span
									className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${w ? severityFill(barPercent) : "bg-success"}`}
									style={{ width: `${clamped}%`, minWidth: clamped > 0 ? "0.125rem" : undefined }}
								/>
							</span>
						);
					})}
				</span>
				{!compact && (
					<span className="text-micro font-medium tabular-nums">
						{unlimited ? (
							t("rateLimits.unlimited")
						) : (
							<>
								{pillWindows.map((w, i) => (
									<span key={w.id}>
										{i > 0 ? <span className="mx-1 font-normal opacity-50">·</span> : null}
										<span className="mr-0.5 font-normal opacity-70">{labelOf(w)}</span>
										{Math.round(w.usedPercent)}%
									</span>
								))}
								<span className="ml-0.5 text-nano font-normal opacity-70">{t("rateLimits.used")}</span>
							</>
						)}
					</span>
				)}
			</button>
			{isNarrow ? (
				<BottomSheet
					open={flyout.open}
					onClose={flyout.close}
					title={t("rateLimits.panelTitle")}
					testId="agent-usage-sheet"
				>
					{panel}
				</BottomSheet>
			) : (
				flyout.open && (
					<HeaderFlyoutPanel
						flyout={flyout}
						width={PANEL_WIDTH}
						ariaLabel={t("rateLimits.panelTitle")}
						testId="agent-usage-panel"
					>
						{panel}
					</HeaderFlyoutPanel>
				)
			)}
		</>
	);
}

export default RateLimitIndicator;
