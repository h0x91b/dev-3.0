import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import { useEscapeKey } from "../hooks/useEscapeKey";

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
}: {
	anchor: DOMRect;
	rows: PopoverRow[];
	busy: boolean;
	hint: string;
	title: string;
	subtitle: string;
	onClose: () => void;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: anchor.top, left: anchor.left });
	const [visible, setVisible] = useState(false);

	useEscapeKey(onClose);
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [onClose]);

	useLayoutEffect(() => {
		if (!menuRef.current) return;
		const menu = menuRef.current.getBoundingClientRect();
		const pad = 8;
		const gap = 6;
		// Open ABOVE the trigger by default: the indicator sits low in the launch
		// modal, so opening downward spilled past the modal over the Launch/Cancel
		// buttons. Flip DOWN only when there isn't enough room above.
		let top = anchor.top - menu.height - gap;
		if (top < pad) {
			const below = anchor.bottom + gap;
			top =
				below + menu.height <= window.innerHeight - pad
					? below
					: Math.max(pad, window.innerHeight - menu.height - pad);
		}
		let left = anchor.left;
		if (left + menu.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - menu.width - pad);
		setPos({ top, left });
		setVisible(true);
	}, [anchor]);

	return createPortal(
		<div
			ref={menuRef}
			className="fixed z-[10000] bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 w-[21rem] max-w-[calc(100vw-1rem)]"
			style={{ top: pos.top, left: pos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 pt-2 pb-2 mb-1 border-b border-edge">
				<div className="text-fg-2 text-xs font-semibold uppercase tracking-wider">{title}</div>
				<p className="text-fg-muted text-[0.6875rem] leading-snug mt-1">{subtitle}</p>
			</div>
			{rows.map((row) => (
				<button
					key={row.key}
					type="button"
					disabled={busy || !row.onSelect || row.isActive}
					onClick={row.onSelect ?? undefined}
					className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${
						row.onSelect && !row.isActive ? "hover:bg-elevated-hover cursor-pointer" : "cursor-default"
					} disabled:opacity-100`}
				>
					<span
						aria-hidden
						className={`w-3 h-3 mt-1 rounded-full border-2 shrink-0 ${
							row.isActive ? "border-accent bg-accent" : "border-fg-muted/50"
						}`}
					/>
					<span className="min-w-0 flex-1">
						<span className="flex items-center gap-2 min-w-0">
							<span className="text-fg text-sm truncate flex-1">{row.label}</span>
							{row.isApi ? (
								<span className="text-warning text-[0.625rem] px-1 py-px bg-warning/10 rounded shrink-0">API</span>
							) : null}
							{row.planLabel ? (
								<span className="text-accent text-[0.625rem] px-1 py-px bg-accent/10 rounded shrink-0">
									{row.planLabel}
								</span>
							) : null}
						</span>
						{(row.sub && row.sub !== row.label && !row.label.includes(row.sub)) || row.workspaceLabel ? (
							<span className="mt-1 flex flex-wrap items-center gap-1.5 min-w-0">
								{row.sub && row.sub !== row.label && !row.label.includes(row.sub) ? (
									<span className="text-fg-muted text-xs font-mono truncate max-w-full">{row.sub}</span>
								) : null}
								{row.workspaceLabel ? (
									<span className="text-fg-3 text-[0.625rem] px-1 py-px bg-raised rounded max-w-full">
										{row.workspaceLabel}
									</span>
								) : null}
							</span>
						) : null}
					</span>
				</button>
			))}
			<div className="border-t border-edge mt-1 pt-1.5 px-3 pb-1">
				<p className="text-fg-muted text-[0.6875rem] leading-snug">{hint}</p>
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
				toast.error(err instanceof Error ? err.message : String(err));
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
				onClick={() => setAnchor(buttonRef.current?.getBoundingClientRect() ?? null)}
				className="mt-1 flex items-center gap-1 max-w-full text-[0.6875rem] text-fg-3 hover:text-fg transition-colors"
				title={t("launch.accountSwitcherTooltip")}
			>
				<span
					aria-hidden
					className="text-[0.75rem] leading-none shrink-0"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0004}"}
				</span>
				<span className="truncate">{activeLabel}</span>
				{selectedAccount?.auth === "api" ? (
					<span className="text-warning text-[0.625rem] px-1 py-px bg-warning/10 rounded shrink-0">API</span>
				) : null}
				<span
					aria-hidden
					className="text-[0.625rem] leading-none shrink-0 text-fg-muted"
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
				/>
			) : null}
		</>
	);
}
