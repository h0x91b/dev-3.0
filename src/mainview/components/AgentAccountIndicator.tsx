import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type {
	AgentAccount,
	AgentAccountIdentity,
	AgentAccountKind,
	AgentAccountsState,
	AgentApiProfileInfo,
} from "../../shared/agent-accounts";
import { shortCodexWorkspaceId } from "../../shared/agent-accounts";
import type { CodingAgent } from "../../shared/types";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport } from "../../shared/rate-limits";
import {
	RATE_LIMIT_DANGER_PERCENT,
	formatResetDelta,
	isUnlimitedRateLimitSnapshot,
	windowLabel,
} from "../../shared/rate-limits";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { CapturedAgeSuffix, UsageBar, severityText } from "./rate-limit-ui";

/** Fired on window after any account mutation (switch from this popover,
 *  add/remove/switch in Settings → Agent Accounts), so every mounted listener
 *  (indicators in variant rows, the settings section) refetches without a
 *  push channel. */
export const AGENT_ACCOUNTS_CHANGED_EVENT = "dev3:agentAccountsChanged";

export function notifyAgentAccountsChanged(): void {
	window.dispatchEvent(new CustomEvent(AGENT_ACCOUNTS_CHANGED_EVENT));
}

/** Which account registry an agent's base command draws from. Handles path
 *  prefixes ("/opt/bin/claude") and wrapper args ("claude --foo"); anything
 *  that isn't claude/codex has no account switcher — the indicator hides. */
export function agentAccountKindForCommand(baseCommand: string): AgentAccountKind | null {
	const first = baseCommand.trim().split(/\s+/)[0] ?? "";
	const name = first.split("/").pop() ?? "";
	if (name === "claude") return "claude";
	if (name === "codex") return "codex";
	return null;
}

function useAgentAccountsState(enabled: boolean): AgentAccountsState | null {
	const [state, setState] = useState<AgentAccountsState | null>(null);
	const reload = useCallback(() => {
		api.request
			.listAgentAccounts()
			.then(setState)
			.catch(() => {});
	}, []);
	useEffect(() => {
		if (!enabled) return;
		reload();
		window.addEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, reload);
		return () => window.removeEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, reload);
	}, [enabled, reload]);
	return enabled ? state : null;
}

/** Rate-limit report, fetched lazily (popover open) + refreshed by push. */
function useAgentRateLimits(enabled: boolean): AgentRateLimitsReport | null {
	const [report, setReport] = useState<AgentRateLimitsReport | null>(null);
	useEffect(() => {
		if (!enabled) return;
		// Promise.resolve wrapper also absorbs a synchronously-missing RPC method
		// (plain-object api mocks in tests); rows just render without usage.
		Promise.resolve()
			.then(() => api.request.getAgentRateLimits())
			.then(setReport)
			.catch(() => {});
		function onUpdate(e: Event) {
			setReport((e as CustomEvent).detail as AgentRateLimitsReport);
		}
		window.addEventListener("rpc:agentRateLimitsUpdated", onUpdate);
		return () => window.removeEventListener("rpc:agentRateLimitsUpdated", onUpdate);
	}, [enabled]);
	return enabled ? report : null;
}

/** One row's rate-limit reading, joined from the report by source + account. */
interface RowUsage {
	/** null = OAuth account with no reading in the 7-day activity window. */
	snap: AgentRateLimitSnapshot | null;
	state: "used" | "unlimited" | "none";
}

interface QuotaLine {
	key: string;
	label: string;
	usedPercent: number;
	resetsAt: number | null;
}

function quotaLines(snap: AgentRateLimitSnapshot, monthlyLabel: string): QuotaLine[] {
	const monthly = snap.monthlyCredits;
	// Same de-dup as AccountCard: the monthly_credits window mirrors
	// snap.monthlyCredits, which gets its own line.
	const lines: QuotaLine[] = snap.windows
		.filter((win) => !(win.id === "monthly_credits" && monthly))
		.map((win) => ({ key: win.id, label: windowLabel(win), usedPercent: win.usedPercent, resetsAt: win.resetsAt }));
	if (monthly) {
		lines.push({
			key: "monthly",
			label: monthlyLabel,
			usedPercent: Math.max(0, 100 - monthly.remainingPercent),
			resetsAt: monthly.resetsAt,
		});
	}
	return lines;
}

/** An unlimited account has no bars to show, so the chip carries its whole
 *  reading; every other state renders its numbers in the quota block below. */
function RowHeadline({ usage }: { usage: RowUsage }) {
	const t = useT();
	if (!usage.snap || usage.state !== "unlimited") return null;
	return (
		<span className="text-success-strong text-micro px-1 py-px bg-success/10 rounded font-medium shrink-0">
			{t("rateLimits.unlimited")}
		</span>
	);
}

/** Per-account quota block, always visible: one dense "label · bar · % · reset"
 *  line per limit window. Picking an account is a comparison, so hiding the bars
 *  behind a per-row toggle made every open cost a click (decision: inline). */
function RowQuota({ usage, now }: { usage: RowUsage; now: number }) {
	const t = useT();
	if (!usage.snap || usage.state !== "used") return null;
	const lines = quotaLines(usage.snap, t("rateLimits.monthlyLabel"));
	if (lines.length === 0) return null;
	const exhausted = lines.some((line) => line.usedPercent >= RATE_LIMIT_DANGER_PERCENT);
	const lastKey = lines[lines.length - 1]?.key;
	return (
		<span className="mt-1 block">
			{lines.map((line) => {
				const percent = Math.round(line.usedPercent);
				const reset = formatResetDelta(line.resetsAt, now);
				return (
					<span key={line.key} className="mt-1 flex items-center gap-1.5">
						<span className="min-w-[1.5rem] shrink-0 text-xs text-fg-3 tabular-nums whitespace-nowrap">{line.label}</span>
						<UsageBar percent={line.usedPercent} className="h-1 min-w-[3rem] flex-1" />
						<span className="shrink-0 text-xs tabular-nums whitespace-nowrap">
							<span className={`font-semibold ${severityText(percent)}`}>
								{t("rateLimits.percentUsed", { percent: String(percent) })}
							</span>
							{reset && <span className="text-fg-3"> · {t("rateLimits.resetsIn", { time: reset })}</span>}
							{/* Provenance rides the last line: a reading is only as good as its age,
							    and a separate line per account doubled the block's height. */}
							{line.key === lastKey && <CapturedAgeSuffix capturedAt={usage.snap!.capturedAt} now={now} />}
						</span>
					</span>
				);
			})}
			{exhausted && <span className="mt-1 block text-xs text-danger">{t("rateLimits.quotaExhausted")}</span>}
		</span>
	);
}

function identityBadge(identity: AgentAccountIdentity | null): string | null {
	return identity?.planLabel ?? null;
}

function apiHost(info: AgentApiProfileInfo | null): string | null {
	if (!info?.baseUrl) return null;
	try {
		return new URL(info.baseUrl).host;
	} catch {
		return info.baseUrl;
	}
}

interface PopoverRow {
	key: string;
	label: string;
	sub: string | null;
	planLabel: string | null;
	workspaceLabel: string | null;
	isApi: boolean;
	isActive: boolean;
	/** Rate-limit reading for this account; null while the report is loading
	 *  or for API profiles (no OAuth limit windows). */
	usage: RowUsage | null;
	/** null = row is informational only (codex unmanaged login). */
	onSelect: (() => void) | null;
}

function SwitcherPopover({
	anchor,
	rows,
	busy,
	hint,
	title,
	subtitle,
	onClose,
	triggerRef,
}: {
	anchor: DOMRect;
	rows: PopoverRow[];
	busy: boolean;
	hint: string;
	title: string;
	subtitle: string;
	onClose: () => void;
	triggerRef: RefObject<HTMLButtonElement | null>;
}) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: anchor.top, left: anchor.left });
	const [visible, setVisible] = useState(false);
	const now = Date.now();

	// Registers the panel as an overlay layer: Tab reaches it, Escape closes it
	// before the surrounding modal, focus leaving it dismisses it.
	useOverlayLayer(menuRef, { onDismiss: onClose, triggerRef, autoFocus: true });
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [onClose]);

	const reposition = useCallback(() => {
		if (!menuRef.current) return;
		const menu = menuRef.current.getBoundingClientRect();
		const pad = 8;
		const gap = 6;
		// Clamp inside the anchoring dialog when there is one: opening upward covered
		// the dialog's own title and picker fields, opening past its edge hid the
		// panel behind the modal's own chrome.
		const dialog = triggerRef.current?.closest("[role=dialog]")?.getBoundingClientRect() ?? null;
		const minTop = Math.max(pad, dialog ? dialog.top + pad : pad);
		const maxBottom = Math.min(window.innerHeight - pad, dialog ? dialog.bottom - pad : window.innerHeight - pad);
		const below = anchor.bottom + gap;
		const above = anchor.top - menu.height - gap;
		// Prefer BELOW; flip above only when below does not fit the dialog. The final
		// clamp is against the viewport — a panel taller than its dialog must stay
		// fully visible rather than be cut off at the screen edge.
		let top = below;
		if (below + menu.height > maxBottom && above >= minTop) top = above;
		top = Math.max(pad, Math.min(top, window.innerHeight - pad - menu.height));
		const minLeft = Math.max(pad, dialog ? dialog.left + pad : pad);
		const maxRight = Math.min(window.innerWidth - pad, dialog ? dialog.right - pad : window.innerWidth - pad);
		let left = anchor.left;
		if (left + menu.width > maxRight) left = Math.max(minLeft, maxRight - menu.width);
		setPos({ top, left });
		setVisible(true);
	}, [anchor, triggerRef]);

	// The panel grows after mount (usage readings arrive async, rows expand), so
	// measure-once would leave it hanging off the screen.
	useLayoutEffect(() => {
		reposition();
		const panel = menuRef.current;
		if (!panel || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(reposition);
		observer.observe(panel);
		return () => observer.disconnect();
	}, [reposition]);

	const autoFocusKey = (rows.find((row) => row.isActive) ?? rows[0])?.key ?? null;

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			aria-label={title}
			className="fixed z-[10000] bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 w-[25rem] max-w-[calc(100vw-1rem)]"
			// Opacity, not `visibility`, hides the pre-measure frame: a
			// visibility-hidden element cannot take focus, so autofocusing the
			// active row silently did nothing.
			style={{ top: pos.top, left: pos.left, opacity: visible ? 1 : 0 }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 pt-2 pb-2 mb-1 border-b border-edge">
				<div className="text-fg-2 text-sm font-semibold uppercase tracking-wider">{title}</div>
				<p className="text-fg-3 text-xs leading-snug mt-1">{subtitle}</p>
			</div>
			{/* Usage bars make a row 3 lines tall, so the list is the part that scrolls —
			    the title block and the provenance hint stay pinned. */}
			<div className="max-h-[min(28rem,60vh)] overflow-y-auto overscroll-contain">
				{rows.map((row) => {
					// Informational rows (codex "unmanaged") and a busy switch stay inert —
					// via aria-disabled, so every row keeps its place in the Tab ring.
					const inert = busy || !row.onSelect;
					const showSub = !!row.sub && row.sub !== row.label && !row.label.includes(row.sub);
					return (
						<div
							key={row.key}
							className={`flex items-start ${inert ? "" : "hover:bg-elevated-hover"} transition-colors`}
						>
							<button
								type="button"
								role="menuitemradio"
								aria-checked={row.isActive}
								aria-disabled={inert || undefined}
								data-overlay-autofocus={row.key === autoFocusKey ? "" : undefined}
								onClick={() => {
									if (inert) return;
									row.onSelect?.();
								}}
								className={`min-w-0 flex-1 text-left pl-3 pr-3 py-2 flex items-start gap-2 focus:bg-elevated-hover ${
									inert ? "cursor-default" : "cursor-pointer"
								}`}
							>
								<span
									aria-hidden
									className={`w-3 h-3 mt-1 rounded-full border-2 shrink-0 ${
										row.isActive ? "border-accent bg-accent" : "border-fg-3"
									}`}
								/>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-2 min-w-0">
										<span title={row.label} className="text-fg text-sm truncate flex-1 streamer-private">
											{row.label}
										</span>
										{row.isApi ? (
											<span className="text-fg-3 text-micro px-1 py-px bg-raised rounded shrink-0">API</span>
										) : null}
										{row.planLabel ? (
											<span className="text-fg-3 text-micro px-1 py-px bg-raised rounded shrink-0">
												{row.planLabel}
											</span>
										) : null}
										{row.usage ? <RowHeadline usage={row.usage} /> : null}
									</span>
									{showSub || row.workspaceLabel ? (
										<span className="mt-1 flex flex-wrap items-center gap-1.5 min-w-0">
											{showSub ? (
												<span
													title={row.sub ?? undefined}
													className="text-fg-3 text-xs font-mono truncate max-w-full streamer-private"
												>
													{row.sub}
												</span>
											) : null}
											{row.workspaceLabel ? (
												<span className="text-fg-3 text-micro px-1 py-px bg-raised rounded max-w-full streamer-private">
													{row.workspaceLabel}
												</span>
											) : null}
										</span>
									) : null}
									{row.usage && row.usage.state === "none" ? (
										<span className="mt-1 block text-xs text-fg-3">{t("rateLimits.noRecentData")}</span>
									) : null}
									{row.usage ? <RowQuota usage={row.usage} now={now} /> : null}
								</span>
								{row.isActive ? (
									<svg
										aria-hidden
										className="w-3.5 h-3.5 mt-1 shrink-0 text-accent"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth={2.5}
									>
										<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
									</svg>
								) : null}
							</button>
						</div>
					);
				})}
			</div>
			<div className="border-t border-edge mt-1 pt-1.5 px-3 pb-1">
				<p className="text-fg-3 text-xs leading-snug">{hint}</p>
			</div>
		</div>,
		document.body,
	);
}

/**
 * Account pill under the launch picker's Provider field. Two modes:
 *
 * - **Local per-launch selector** (`onSelect` provided): picking writes to the
 *   caller's state for THIS launch only — no global mutation, no confirm. Used
 *   by the spawn dialogs (Launch Variants / Spawn Agent / Bug Hunters).
 * - **Global default switcher** (`onSelect` omitted): picking moves the default
 *   account (billing acknowledgement kept). Used by Settings surfaces.
 *
 * Progressive disclosure: renders nothing unless the selected provider is a
 * claude/codex command AND the user has registered managed accounts — a
 * single-login user never sees it.
 */
export default function AgentAccountIndicator({
	agent,
	value,
	onSelect,
}: {
	agent: CodingAgent | undefined | null;
	/** Per-launch selection: `undefined` → the registry default (the preselect);
	 *  `null` → the system login; a string → that managed account. Local mode only. */
	value?: string | null;
	/** When provided the pill is a LOCAL per-launch selector (no global mutation,
	 *  no confirm). When omitted it stays the global default switcher. */
	onSelect?: (accountId: string | null) => void;
}) {
	const t = useT();
	const kind = agent ? agentAccountKindForCommand(agent.baseCommand) : null;
	const state = useAgentAccountsState(kind !== null);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const [busy, setBusy] = useState(false);
	// Usage rings only matter while the popover is open — fetch lazily then.
	const report = useAgentRateLimits(anchor !== null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const isLocal = !!onSelect;

	const handleSelectLocal = useCallback(
		(accountId: string | null) => {
			setAnchor(null);
			onSelect?.(accountId);
		},
		[onSelect],
	);

	const handleSelectGlobal = useCallback(
		async (accountKind: AgentAccountKind, accountId: string | null) => {
			setBusy(true);
			setAnchor(null);
			try {
				// Setting the DEFAULT account only changes the preselect for future
				// launches (no ~/.codex swap, no running-session cost move), so no
				// confirmation — the per-launch selector is the real guard.
				await api.request.setActiveAgentAccount({ kind: accountKind, accountId });
				notifyAgentAccountsChanged();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err), { source: "settings" });
			} finally {
				setBusy(false);
			}
		},
		[],
	);

	if (!kind || !state) return null;
	const kindState = state[kind];
	if (kindState.accounts.length === 0) return null;

	// The effective selected id: the local per-launch value (undefined → the
	// registry default) or, for the global switcher, the registry default itself.
	const effectiveSelectedId = isLocal && value !== undefined ? value : kindState.activeId;

	const selectedAccount: AgentAccount | null = kindState.accounts.find((a) => a.id === effectiveSelectedId) ?? null;
	const fallbackIdentity = kind === "claude" ? state.claude.systemIdentity : state.codex.currentIdentity;
	const fallbackLabel =
		kind === "claude" ? t("settings.accountsSystemLogin") : t("settings.accountsUnmanaged");
	const activeLabel = selectedAccount ? selectedAccount.label : (fallbackIdentity?.email ?? fallbackLabel);
	const workspaceLabel = (identity: AgentAccountIdentity | null): string | null => {
		if (kind !== "codex") return null;
		const workspace = identity?.organization ?? shortCodexWorkspaceId(identity);
		return workspace ? t("settings.accountsWorkspace", { id: workspace }) : null;
	};

	// Join the rate-limit report to a row's account: null accountId = the
	// provider's system login. API profiles have no OAuth limit windows.
	const usageFor = (accountId: string | null, isApi = false): RowUsage | null => {
		if (!report || isApi) return null;
		const snap = report.snapshots.find((s) => s.source === kind && (s.accountId ?? null) === accountId) ?? null;
		if (!snap) return { snap: null, state: "none" };
		if (isUnlimitedRateLimitSnapshot(snap)) return { snap, state: "unlimited" };
		return { snap, state: snap.windows.length > 0 || snap.monthlyCredits ? "used" : "none" };
	};

	const rows: PopoverRow[] = [];
	// System-login row: selectable for BOTH kinds in local mode (codex now has a
	// real system-login fallback); in the global switcher it stays claude-only
	// selectable, and codex renders an informational "unmanaged" row.
	if (kind === "claude" || isLocal) {
		rows.push({
			key: "system",
			label: kind === "claude" ? t("settings.accountsSystemLogin") : t("settings.accountsUnmanaged"),
			sub: fallbackIdentity?.email ?? null,
			planLabel: identityBadge(fallbackIdentity),
			workspaceLabel: workspaceLabel(fallbackIdentity),
			isApi: false,
			isActive: effectiveSelectedId === null,
			usage: usageFor(null),
			onSelect: isLocal
				? () => handleSelectLocal(null)
				: () => handleSelectGlobal("claude", null),
		});
	} else if (kindState.activeId === null && state.codex.currentIdentity) {
		rows.push({
			key: "unmanaged",
			label: t("settings.accountsUnmanaged"),
			sub: state.codex.currentIdentity.email,
			planLabel: identityBadge(state.codex.currentIdentity),
			workspaceLabel: workspaceLabel(state.codex.currentIdentity),
			isApi: false,
			isActive: true,
			usage: usageFor(null),
			onSelect: null,
		});
	}
	for (const account of kindState.accounts) {
		rows.push({
			key: account.id,
			label: account.label,
			sub: account.auth === "api" ? apiHost(account.api) : (account.identity?.email ?? null),
			planLabel: account.auth === "api" ? null : identityBadge(account.identity),
			workspaceLabel: workspaceLabel(account.identity),
			isApi: account.auth === "api",
			isActive: account.id === effectiveSelectedId,
			usage: usageFor(account.id, account.auth === "api"),
			onSelect: isLocal
				? () => handleSelectLocal(account.id)
				: () => handleSelectGlobal(kind, account.id),
		});
	}

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				data-testid="agent-account-trigger"
				aria-haspopup="menu"
				aria-expanded={anchor !== null}
				onClick={() => setAnchor(buttonRef.current?.getBoundingClientRect() ?? null)}
				className="mt-1 flex items-center gap-1 max-w-full text-micro text-fg-3 hover:text-fg transition-colors"
				title={t("launch.accountSwitcherTooltip")}
			>
				<span
					aria-hidden
					className="text-xs leading-none shrink-0"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0004}"}
				</span>
				<span title={activeLabel} className="truncate streamer-private">
					{activeLabel}
				</span>
				{selectedAccount?.auth === "api" ? (
					<span className="text-fg-3 text-micro px-1 py-px bg-raised rounded shrink-0">API</span>
				) : null}
				<span
					aria-hidden
					className="text-micro leading-none shrink-0 text-fg-muted"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0140}"}
				</span>
			</button>
			{anchor ? (
				<SwitcherPopover
					anchor={anchor}
					rows={rows}
					busy={busy}
					hint={isLocal ? t("launch.accountForLaunchHint") : t("settings.accountsNewSessionsHint")}
					title={isLocal ? t("launch.accountForLaunchTitle") : t("launch.accountActiveTitle")}
					subtitle={isLocal ? t("launch.accountForLaunchSubtitle") : t("launch.accountGlobalSubtitle")}
					onClose={() => setAnchor(null)}
					triggerRef={buttonRef}
				/>
			) : null}
		</>
	);
}
