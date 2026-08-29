import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAccountKind, AgentAccountsState } from "../../shared/agent-accounts";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport, RateLimitSource } from "../../shared/rate-limits";
import { isUnlimitedRateLimitSnapshot } from "../../shared/rate-limits";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT, type TFunction } from "../i18n";
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

/** One card in the panel: an account (or a leftover reading) plus its usage. */
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

/** Everything that distinguishes one row from another, spoken. Several accounts
 *  legitimately share an email, so the name alone names three rows at once. */
function spokenName(row: UsageRow, fallback: string): string {
	const account = row.account;
	if (!account) return fallback;
	const extras = [account.organization, account.planLabel, row.chip].filter((part): part is string => !!part);
	return [account.name, ...extras].join(" · ");
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
	inert,
	focusable,
	onSetDefault,
	onKeyDown,
	rowRef,
	t,
}: {
	row: UsageRow;
	now: number;
	inert: boolean;
	/** Roving tabindex: one stop per group, so Tab does not walk every account. */
	focusable: boolean;
	onSetDefault: () => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
	rowRef: (el: HTMLButtonElement | null) => void;
	t: TFunction;
}) {
	const name = spokenName(row, SOURCE_NAMES[row.kind] ?? row.kind);
	return (
		<button
			ref={rowRef}
			type="button"
			role="radio"
			aria-checked={row.isDefault}
			aria-disabled={inert || undefined}
			tabIndex={focusable ? 0 : -1}
			// Only an actionable row gets the "make default" name; an informational
			// one would otherwise promise something the click cannot do.
			aria-label={inert ? undefined : t("rateLimits.makeDefault", { label: name })}
			onClick={() => {
				if (inert) return;
				onSetDefault();
			}}
			onKeyDown={onKeyDown}
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
 * Usage details for every agent account: the quota cards the header pill has
 * always shown, plus the settings screen's radio semantics — picking a card
 * makes that account the default for new launches (running sessions keep their
 * login). Rendered as the pill's own anchored flyout (or a BottomSheet on
 * narrow), never as a centred dialog: the readout belongs next to the pill it
 * explains, not on top of the whole board.
 *
 * `interactive` is the guard on that mutation. The flyout opens on hover, and a
 * durable setting must not be one stray click away from a panel the pointer
 * merely passed through — so the rows only become choosable once the panel is
 * pinned (or on narrow, where it is a sheet the user deliberately opened).
 */
export default function AgentUsagePanel({
	report,
	accounts,
	interactive,
	onOpenSettings,
}: {
	report: AgentRateLimitsReport;
	accounts: AgentAccountsState | null;
	interactive: boolean;
	onOpenSettings: () => void;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const now = Date.now();
	const rowRefs = useRef(new Map<string, HTMLButtonElement>());
	/** Row keys in render order, so the pin-focus effect does not depend on the
	 *  freshly-rebuilt blocks array. */
	const orderedKeys = useRef<{ key: string; isDefault: boolean }[]>([]);

	const setDefault = useCallback(async (kind: AgentAccountKind, accountId: string | null, label: string) => {
		setBusy(true);
		try {
			// Same contract as Settings → Agent Accounts: the default is only the
			// preselect for future launches, so no confirmation is needed. The toast
			// is the receipt — hover-out can close this panel before the moved
			// "Default" chip is ever seen.
			await api.request.setActiveAgentAccount({ kind, accountId });
			notifyAgentAccountsChanged();
			toast.success(t("rateLimits.defaultSwitched", { label }), { source: "settings" });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err), { source: "settings" });
		} finally {
			setBusy(false);
		}
	}, [t]);

	const labels = { systemLogin: t("settings.accountsSystemLogin"), unmanaged: t("settings.accountsUnmanaged") };
	const blocks = KINDS.map((kind) => ({ kind, rows: rowsForKind(kind, accounts, report, labels) })).filter(
		(block) => block.rows.length > 0,
	);

	const isInert = (row: UsageRow) => busy || !interactive || !row.selectable || row.isDefault;
	orderedKeys.current = blocks.flatMap((block) => block.rows.map((row) => ({ key: row.key, isDefault: row.isDefault })));

	// Pinning is the moment the panel becomes usable, so it is also the moment
	// focus belongs inside it: the panel is portaled to <body>, so Tab from the
	// pill would otherwise walk the rest of the header instead of entering it.
	useEffect(() => {
		if (!interactive) return;
		const rows = orderedKeys.current;
		const target = rows.find((row) => row.isDefault) ?? rows[0];
		if (target) rowRefs.current.get(target.key)?.focus();
	}, [interactive]);

	/** Arrows move focus only; Enter/Space commits. Selection-follows-focus is the
	 *  radiogroup norm, but here a selection writes durable state — arrowing past
	 *  three accounts must not switch the default three times. */
	const onRowKeyDown = (rowsInGroup: UsageRow[], index: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
		const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
		if (delta === 0) return;
		e.preventDefault();
		const next = rowsInGroup[(index + delta + rowsInGroup.length) % rowsInGroup.length];
		if (next) rowRefs.current.get(next.key)?.focus();
	};

	return (
		<div className="p-3 space-y-3 text-xs">
			<p className="text-fg-3 leading-snug">
				{interactive ? t("rateLimits.panelSubtitle") : t("rateLimits.pinToSwitch")}
			</p>
			{blocks.map((block) => {
				// One tab stop per group: the current default, or the first row.
				const stop = block.rows.find((row) => row.isDefault) ?? block.rows[0];
				return (
					<div key={block.kind} className="space-y-1.5">
						<div className="text-fg-2 font-semibold uppercase tracking-wider">
							{SOURCE_NAMES[block.kind] ?? block.kind}
						</div>
						<div role="radiogroup" aria-label={SOURCE_NAMES[block.kind] ?? block.kind} className="space-y-1.5">
							{block.rows.map((row, index) => (
								<UsageRowCard
									key={row.key}
									row={row}
									now={now}
									inert={isInert(row)}
									focusable={row.key === stop?.key}
									onSetDefault={() =>
										setDefault(row.kind, row.accountId, spokenName(row, SOURCE_NAMES[row.kind] ?? row.kind))
									}
									onKeyDown={onRowKeyDown(block.rows, index)}
									rowRef={(el) => {
										if (el) rowRefs.current.set(row.key, el);
										else rowRefs.current.delete(row.key);
									}}
									t={t}
								/>
							))}
						</div>
					</div>
				);
			})}
			{/* Sticky, because a user with several accounts scrolls past the fold and
			    the way out of this panel must not be the thing below it. */}
			<div className="sticky bottom-0 -mx-3 -mb-3 px-3 pb-3 pt-2 bg-overlay">
				<button
					type="button"
					onClick={onOpenSettings}
					className="w-full px-3 py-1.5 rounded-lg border border-edge text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
				>
					{t("rateLimits.manageAccounts")}
				</button>
			</div>
		</div>
	);
}
