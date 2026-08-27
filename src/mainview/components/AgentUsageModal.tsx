import { useCallback, useState } from "react";
import type { AgentAccountKind, AgentAccountsState } from "../../shared/agent-accounts";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport, RateLimitSource } from "../../shared/rate-limits";
import { isUnlimitedRateLimitSnapshot } from "../../shared/rate-limits";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT, type TFunction } from "../i18n";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { notifyAgentAccountsChanged } from "./AgentAccountIndicator";
import {
	ACCOUNT_CARD_CLASS,
	AccountCardHeader,
	AccountQuotaLines,
	SOURCE_NAMES,
	type AccountLine,
	resolveAccount,
} from "./rate-limit-ui";

const KINDS: AgentAccountKind[] = ["claude", "codex"];

/** One card in the modal: an account (or a leftover reading) plus its usage. */
interface UsageRow {
	key: string;
	kind: AgentAccountKind;
	accountId: string | null;
	account: AccountLine | null;
	/** Extra chip next to the identity ("System login", "Unmanaged login"). */
	chip: string | null;
	snap: AgentRateLimitSnapshot | null;
	isDefault: boolean;
	/** false for informational rows: codex's unmanaged login and readings whose
	 *  account is gone — there is nothing to make default. */
	selectable: boolean;
}

function snapshotFor(
	report: AgentRateLimitsReport,
	source: RateLimitSource,
	accountId: string | null,
): AgentRateLimitSnapshot | null {
	return report.snapshots.find((s) => s.source === source && (s.accountId ?? null) === accountId) ?? null;
}

/** Rows for one provider: its accounts first (the switchable set), then any
 *  reading left over from an account that no longer exists. */
function rowsForKind(
	kind: AgentAccountKind,
	accounts: AgentAccountsState | null,
	report: AgentRateLimitsReport,
	labels: { systemLogin: string; unmanaged: string },
): UsageRow[] {
	const rows: UsageRow[] = [];
	const kindState = accounts?.[kind] ?? null;
	const activeId = kindState?.activeId ?? null;
	const named = (name: string): AccountLine => ({
		name,
		email: null,
		organization: null,
		planLabel: null,
		isApi: false,
	});

	// The system login is a real default only for Claude; Codex's current login is
	// unmanaged (dev3 never wrote it), so it stays informational — same rule the
	// settings section and the launch-picker switcher follow.
	if (kind === "claude") {
		const identity = resolveAccount("claude", accounts, null);
		rows.push({
			key: "claude:system",
			kind,
			accountId: null,
			account: identity ?? named(labels.systemLogin),
			// With no identity to show, the row's own name already says "system
			// login" — a chip repeating it would print the label twice.
			chip: identity ? labels.systemLogin : null,
			snap: snapshotFor(report, "claude", null),
			isDefault: activeId === null,
			selectable: true,
		});
	} else if (activeId === null && accounts?.codex.currentIdentity) {
		const identity = resolveAccount("codex", accounts, null);
		rows.push({
			key: "codex:unmanaged",
			kind,
			accountId: null,
			account: identity ?? named(labels.unmanaged),
			chip: identity ? labels.unmanaged : null,
			snap: snapshotFor(report, "codex", null),
			isDefault: true,
			selectable: false,
		});
	}

	for (const account of kindState?.accounts ?? []) {
		rows.push({
			key: `${kind}:${account.id}`,
			kind,
			accountId: account.id,
			account: resolveAccount(kind, accounts, account.id) ?? named(account.label),
			chip: null,
			snap: snapshotFor(report, kind, account.id),
			isDefault: account.id === activeId,
			selectable: true,
		});
	}

	const known = new Set(rows.map((row) => row.accountId));
	for (const snap of report.snapshots) {
		if (snap.source !== kind) continue;
		const id = snap.accountId ?? null;
		if (known.has(id)) continue;
		rows.push({
			key: `${kind}:orphan:${id ?? "system"}`,
			kind,
			accountId: id,
			account: resolveAccount(kind, accounts, id),
			// A reading from the provider's own login while a managed account is the
			// default: name it, so "why can't I pick this one?" answers itself.
			chip: id === null ? (kind === "codex" ? labels.unmanaged : labels.systemLogin) : null,
			snap,
			isDefault: false,
			selectable: false,
		});
	}
	return rows;
}

function UsageRowCard({
	row,
	now,
	busy,
	onSetDefault,
	t,
}: {
	row: UsageRow;
	now: number;
	busy: boolean;
	onSetDefault: () => void;
	t: TFunction;
}) {
	const inert = busy || !row.selectable || row.isDefault;
	const name = row.account?.name ?? SOURCE_NAMES[row.kind] ?? row.kind;
	return (
		<button
			type="button"
			role="radio"
			aria-checked={row.isDefault}
			aria-disabled={inert || undefined}
			// Only an actionable row gets the "make default" name; an informational
			// one would otherwise promise something the click cannot do.
			aria-label={inert ? undefined : t("rateLimits.makeDefault", { label: name })}
			onClick={() => {
				if (inert) return;
				onSetDefault();
			}}
			className={`${ACCOUNT_CARD_CLASS} w-full text-left ${
				row.isDefault ? "border-accent/50" : ""
			} ${inert ? "cursor-default" : "cursor-pointer hover:bg-elevated-hover"} transition-colors`}
		>
			<div className="flex items-center gap-2">
				<span
					aria-hidden
					className={`w-3 h-3 rounded-full border-2 shrink-0 ${
						row.isDefault ? "border-accent bg-accent" : row.selectable ? "border-fg-muted/50" : "border-transparent"
					}`}
				/>
				<span className="min-w-0 flex-1">
					<AccountCardHeader
						source={row.kind}
						account={row.account}
						unlimited={row.snap ? isUnlimitedRateLimitSnapshot(row.snap) : false}
					/>
				</span>
				{row.chip ? (
					<span className="text-fg-3 text-micro px-1 py-px bg-raised rounded shrink-0">{row.chip}</span>
				) : null}
				{row.isDefault ? (
					<span className="text-success text-micro px-1.5 py-0.5 bg-success/15 rounded shrink-0">
						{t("settings.accountsActive")}
					</span>
				) : null}
			</div>
			{row.snap ? (
				<AccountQuotaLines snap={row.snap} now={now} />
			) : (
				<span className="text-fg-muted">{t("rateLimits.noRecentData")}</span>
			)}
		</button>
	);
}

/**
 * Usage details for every agent account, as a modal instead of a hover panel.
 * It is the same quota cards the header pill used to show on hover, plus the
 * settings screen's radio semantics: clicking a card makes that account the
 * default for new launches (running sessions keep their login).
 */
export default function AgentUsageModal({
	report,
	accounts,
	onClose,
	onOpenSettings,
}: {
	report: AgentRateLimitsReport;
	accounts: AgentAccountsState | null;
	onClose: () => void;
	onOpenSettings: () => void;
}) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [busy, setBusy] = useState(false);
	useEscapeKey(onClose);
	const now = Date.now();

	const setDefault = useCallback(async (kind: AgentAccountKind, accountId: string | null) => {
		setBusy(true);
		try {
			// Same contract as Settings → Agent Accounts: the default is only the
			// preselect for future launches, so no confirmation is needed.
			await api.request.setActiveAgentAccount({ kind, accountId });
			notifyAgentAccountsChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err), { source: "settings" });
		} finally {
			setBusy(false);
		}
	}, []);

	const labels = { systemLogin: t("settings.accountsSystemLogin"), unmanaged: t("settings.accountsUnmanaged") };
	const blocks = KINDS.map((kind) => ({ kind, rows: rowsForKind(kind, accounts, report, labels) })).filter(
		(block) => block.rows.length > 0,
	);

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="agent-usage-title"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[30rem] max-w-full max-h-[calc(100dvh-2rem)] flex flex-col outline-none"
			>
				<div className="px-5 pt-5 pb-3 space-y-1">
					<h2 id="agent-usage-title" className="text-fg text-base font-semibold">
						{t("rateLimits.tooltipTitle")}
					</h2>
					<p className="text-fg-3 text-xs leading-snug">{t("rateLimits.modalSubtitle")}</p>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 space-y-3 text-xs">
					{blocks.map((block) => (
						<div key={block.kind} className="space-y-1.5">
							<div className="text-fg-2 text-xs font-semibold uppercase tracking-wider">
								{SOURCE_NAMES[block.kind] ?? block.kind}
							</div>
							<div role="radiogroup" aria-label={SOURCE_NAMES[block.kind] ?? block.kind} className="space-y-1.5">
								{block.rows.map((row) => (
									<UsageRowCard
										key={row.key}
										row={row}
										now={now}
										busy={busy}
										onSetDefault={() => setDefault(row.kind, row.accountId)}
										t={t}
									/>
								))}
							</div>
						</div>
					))}
					<p className="text-fg-muted text-xs">{t("settings.accountsNewSessionsHint")}</p>
				</div>
				<div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
					<button
						type="button"
						onClick={onOpenSettings}
						className="px-3 py-1.5 text-xs rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
					>
						{t("rateLimits.manageAccounts")}
					</button>
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 text-xs rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors"
					>
						{t("common.close")}
					</button>
				</div>
			</div>
		</div>
	);
}
