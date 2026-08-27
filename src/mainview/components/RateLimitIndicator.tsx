import { useEffect, useState } from "react";
import { api } from "../rpc";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { useT } from "../i18n";
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
	isUnlimitedRateLimitSnapshot,
	latestRateLimitSnapshot,
	windowLabel,
	worstSnapshotWindow,
} from "../../shared/rate-limits";
import type { AgentAccountsState } from "../../shared/agent-accounts";
import { AGENT_ACCOUNTS_CHANGED_EVENT } from "./AgentAccountIndicator";
import { SOURCE_NAMES, severityFill } from "./rate-limit-ui";
import AgentUsagePanel from "./AgentUsagePanel";

/** The pill stacks one mini bar per account, capped to keep the header slim. */
const MAX_PILL_BARS = 4;

/** Panel width in px — wide enough for a "label · bar · % · reset" line. */
const PANEL_WIDTH = 26 * 16;

/**
 * Ambient agent rate-limit indicator (global header, stateful-indicators zone).
 * "Battery gauge" for the account-wide Claude/Codex limit windows so a
 * dev running many parallel agents is never blindsided by hitting a limit.
 * Hidden until usable data exists; shows the most constrained window for the
 * most recently active account and treats unlimited credits as 0% used.
 * Hovering drops its panel below the pill (a click pins it open, so the rows
 * inside can be used): the same per-account quota cards, plus the settings
 * screen's radio control for the default account. Codex monthly credits come from a cached
 * app-server account read; all other data comes from local files — see
 * rate-limit-monitor.ts.
 */
function RateLimitIndicator({ compact = false }: { compact?: boolean }) {
	const t = useT();
	const [report, setReport] = useState<AgentRateLimitsReport | null>(null);
	const [accounts, setAccounts] = useState<AgentAccountsState | null>(null);
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	// Same open/pin/position machinery as the memory-headroom readout: hover drops
	// the panel below the pill, a click pins it so its rows can be clicked.
	const flyout = useHeaderFlyout({ variant: "bar", isNarrow, repositionKey: report });

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

	const latestReset = formatResetDelta(latestWindow?.resetsAt ?? null, now);
	const latestLabel = latestWindow
		? latestWindow.id === "monthly_credits"
			? t("rateLimits.monthlyLabel")
			: windowLabel(latestWindow)
		: null;
	const ariaLabel = unlimited
		? `${t("rateLimits.tooltipTitle")}: ${SOURCE_NAMES[latestSnapshot.source] ?? latestSnapshot.source} ${t("rateLimits.unlimited")}`
		: `${t("rateLimits.tooltipTitle")}: ${SOURCE_NAMES[latestSnapshot.source] ?? latestSnapshot.source}${latestLabel ? ` ${latestLabel}` : ""} ${t("rateLimits.percentUsed", { percent })}${latestReset ? `, ${t("rateLimits.resetsIn", { time: latestReset })}` : ""}`;
	const interactiveAriaLabel = `${ariaLabel}. ${t("rateLimits.openAccounts")}`;

	const pillSnapshots = report.snapshots.slice(0, MAX_PILL_BARS);

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
			report={report}
			accounts={accounts}
			onOpenSettings={() => {
				flyout.close();
				openAccountsSettings();
			}}
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
				{/* One mini bar per recently active account, top-to-bottom in the
				    same order as the panel cards. Unlimited accounts render a
				    full success bar (matching the ∞ chip) instead of a fake 0%.
				    In compact mode the bars ARE the whole pill. */}
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
				{!compact && (
					<span className="text-micro font-medium tabular-nums">
						{unlimited ? (
							t("rateLimits.unlimited")
						) : (
							<>
								{percent}%<span className="ml-0.5 text-nano font-normal opacity-70">{t("rateLimits.used")}</span>
							</>
						)}
					</span>
				)}
			</button>
			{isNarrow ? (
				<BottomSheet
					open={flyout.open}
					onClose={flyout.close}
					title={t("rateLimits.tooltipTitle")}
					testId="agent-usage-sheet"
				>
					{panel}
				</BottomSheet>
			) : (
				flyout.open && (
					<HeaderFlyoutPanel
						flyout={flyout}
						width={PANEL_WIDTH}
						ariaLabel={t("rateLimits.tooltipTitle")}
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
