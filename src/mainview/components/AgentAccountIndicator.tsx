import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
	AgentAccount,
	AgentAccountIdentity,
	AgentAccountKind,
	AgentAccountsState,
	AgentApiProfileInfo,
} from "../../shared/agent-accounts";
import type { CodingAgent } from "../../shared/types";
import { api } from "../rpc";
import { confirm } from "../confirm";
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
	onClose,
}: {
	anchor: DOMRect;
	rows: PopoverRow[];
	busy: boolean;
	hint: string;
	title: string;
	onClose: () => void;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: anchor.bottom + 4, left: anchor.left });
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
		let top = anchor.bottom + 4;
		let left = anchor.left;
		if (top + menu.height > window.innerHeight - pad) top = Math.max(pad, anchor.top - menu.height - 4);
		if (left + menu.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - menu.width - pad);
		setPos({ top, left });
		setVisible(true);
	}, [anchor]);

	return createPortal(
		<div
			ref={menuRef}
			className="fixed z-[10000] bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 w-[19rem] max-w-[calc(100vw-1rem)]"
			style={{ top: pos.top, left: pos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 py-1.5 text-xs text-fg-3 uppercase tracking-wider font-semibold">{title}</div>
			{rows.map((row) => (
				<button
					key={row.key}
					type="button"
					disabled={busy || !row.onSelect || row.isActive}
					onClick={row.onSelect ?? undefined}
					className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
						row.onSelect && !row.isActive ? "hover:bg-elevated-hover cursor-pointer" : "cursor-default"
					} disabled:opacity-100`}
				>
					<span
						aria-hidden
						className={`w-3 h-3 rounded-full border-2 shrink-0 ${
							row.isActive ? "border-accent bg-accent" : "border-fg-muted/50"
						}`}
					/>
					<span className="text-fg text-sm truncate">{row.label}</span>
					{row.isApi ? (
						<span className="text-warning text-[0.625rem] px-1 py-px bg-warning/10 rounded shrink-0">API</span>
					) : null}
					{row.sub && row.sub !== row.label ? (
						<span className="text-fg-muted text-xs font-mono truncate">{row.sub}</span>
					) : null}
					<span className="flex-1" />
					{row.planLabel ? (
						<span className="text-accent text-[0.625rem] px-1 py-px bg-accent/10 rounded shrink-0">{row.planLabel}</span>
					) : null}
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
 * "via <active account>" line under the launch picker's Provider field.
 *
 * Progressive disclosure: renders nothing unless the selected provider is a
 * claude/codex command AND the user has registered managed accounts — a
 * single-login user never sees it. Clicking opens a quick popover switcher
 * (same global switch as Settings → Agent Accounts; affects new sessions only).
 */
export default function AgentAccountIndicator({ agent }: { agent: CodingAgent | undefined | null }) {
	const t = useT();
	const kind = agent ? agentAccountKindForCommand(agent.baseCommand) : null;
	const state = useAgentAccountsState(kind !== null);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const [busy, setBusy] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);

	const handleSelect = useCallback(
		async (accountKind: AgentAccountKind, accountId: string | null, name: string) => {
			setBusy(true);
			try {
				// Billing-sensitive: same acknowledgement as the settings section —
				// every NEW session (and its cost) moves to the target account.
				const ok = await confirm({
					title: t("settings.accountsSwitchConfirmTitle"),
					message: t("settings.accountsSwitchConfirmMessage", { name }),
					danger: true,
				});
				if (!ok) return;
				await api.request.setActiveAgentAccount({ kind: accountKind, accountId });
				notifyAgentAccountsChanged();
				setAnchor(null);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[t],
	);

	if (!kind || !state) return null;
	const kindState = state[kind];
	if (kindState.accounts.length === 0) return null;

	const active: AgentAccount | null = kindState.accounts.find((a) => a.id === kindState.activeId) ?? null;
	const fallbackIdentity = kind === "claude" ? state.claude.systemIdentity : state.codex.currentIdentity;
	const fallbackLabel =
		kind === "claude" ? t("settings.accountsSystemLogin") : t("settings.accountsUnmanaged");
	const activeLabel = active ? active.label : (fallbackIdentity?.email ?? fallbackLabel);

	const rows: PopoverRow[] = [];
	if (kind === "claude") {
		rows.push({
			key: "system",
			label: t("settings.accountsSystemLogin"),
			sub: state.claude.systemIdentity?.email ?? null,
			planLabel: identityBadge(state.claude.systemIdentity),
			isApi: false,
			isActive: kindState.activeId === null,
			onSelect: () => handleSelect("claude", null, t("settings.accountsSystemLogin")),
		});
	} else if (kindState.activeId === null && state.codex.currentIdentity) {
		rows.push({
			key: "unmanaged",
			label: t("settings.accountsUnmanaged"),
			sub: state.codex.currentIdentity.email,
			planLabel: identityBadge(state.codex.currentIdentity),
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
			isApi: account.auth === "api",
			isActive: account.id === kindState.activeId,
			onSelect: () => handleSelect(kind, account.id, account.label),
		});
	}

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				onClick={() => setAnchor(buttonRef.current?.getBoundingClientRect() ?? null)}
				className="mt-1 flex items-center gap-1 max-w-full text-[0.6875rem] text-fg-muted hover:text-fg-2 transition-colors"
				title={t("launch.accountTitle")}
			>
				<span
					aria-hidden
					className="text-[0.75rem] leading-none shrink-0"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0004}"}
				</span>
				<span className="truncate">{t("launch.accountVia", { name: activeLabel })}</span>
				{active?.auth === "api" ? (
					<span className="text-warning text-[0.625rem] px-1 py-px bg-warning/10 rounded shrink-0">API</span>
				) : null}
			</button>
			{anchor ? (
				<SwitcherPopover
					anchor={anchor}
					rows={rows}
					busy={busy}
					hint={t("settings.accountsNewSessionsHint")}
					title={t("launch.accountTitle")}
					onClose={() => setAnchor(null)}
				/>
			) : null}
		</>
	);
}
