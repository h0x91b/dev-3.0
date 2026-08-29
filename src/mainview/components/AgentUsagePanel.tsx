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
	CapturedAgeSuffix,
	SOURCE_NAMES,
	type AccountLine,
	hasQuotaLines,
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
			<div className="flex items-center gap-1.5">
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
					<span className="text-success text-micro px-1 py-px bg-success/15 rounded shrink-0">
						{t("settings.accountsActive")}
					</span>
				) : null}
				{/* An account with nothing to plot says so on its headline instead of
				    spending a whole second line on three muted words. */}
				{!row.snap ? <span className="text-fg-muted text-micro shrink-0">{t("rateLimits.noRecentData")}</span> : null}
				{row.snap && !hasQuotaLines(row.snap) ? (
					<span className="shrink-0 tabular-nums">
						<CapturedAgeSuffix capturedAt={row.snap.capturedAt} now={now} />
					</span>
				) : null}
			</div>
			{row.snap && hasQuotaLines(row.snap) ? <AccountQuotaLines snap={row.snap} now={now} /> : null}
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
 * A durable setting must not be one stray click away from a panel the pointer
 * merely passed through, so the rows arm rather than being born live. What arms
 * them is dwell: the pointer resting inside the panel for ARM_DELAY_MS. A
 * pointer crossing the header towards another icon never lingers there, while a
 * user who came to switch accounts has already spent longer than that reading
 * the rows. `interactive` is the arming that needs no dwell — a pinned flyout,
 * or the narrow sheet the user deliberately opened.
 *
 * It used to be the pin alone, and the pin is a click on the pill ABOVE the
 * panel: the affordance for using a panel sat outside it, so the rows read as
 * simply dead.
 */

/** Long enough that a pointer merely travelling across the panel never arms it,
 *  short enough to be over before anyone can read a row and reach for it. */
const ARM_DELAY_MS = 300;

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
	const [dwelled, setDwelled] = useState(false);
	const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

	const armed = interactive || dwelled;
	const isInert = (row: UsageRow) => busy || !armed || !row.selectable || row.isDefault;
	orderedKeys.current = blocks.flatMap((block) => block.rows.map((row) => ({ key: row.key, isDefault: row.isDefault })));

	// Pinning is the moment the panel becomes usable to a KEYBOARD, so it is also
	// the moment focus belongs inside it: the panel is portaled to <body>, so Tab
	// from the pill would otherwise walk the rest of the header instead of
	// entering it. Deliberately not keyed to `armed` — dwelling means the pointer
	// is there, and moving focus under a mouse user steals it from wherever they
	// were typing.
	useEffect(() => {
		if (!interactive) return;
		const rows = orderedKeys.current;
		const target = rows.find((row) => row.isDefault) ?? rows[0];
		if (target) rowRefs.current.get(target.key)?.focus();
	}, [interactive]);

	useEffect(() => () => {
		if (dwellTimer.current !== null) clearTimeout(dwellTimer.current);
	}, []);

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
		// p-1.5 (6px) inside the flyout's rounded-xl (12px) makes the cards'
		// rounded-md (6px) concentric with the panel's own corners.
		<div
			className="p-1.5 space-y-1.5 text-xs"
			onMouseEnter={() => {
				if (dwellTimer.current !== null) clearTimeout(dwellTimer.current);
				dwellTimer.current = setTimeout(() => {
					dwellTimer.current = null;
					setDwelled(true);
				}, ARM_DELAY_MS);
			}}
			onMouseLeave={() => {
				if (dwellTimer.current !== null) clearTimeout(dwellTimer.current);
				dwellTimer.current = null;
				setDwelled(false);
			}}
		>
			{/* Hint and the way out share one line. The way out used to be a
			    full-width bordered button pinned to the bottom on its own sticky
			    strip — 46px of chrome for a link nobody opens twice. */}
			<div className="flex items-baseline gap-2 px-2 pt-0.5 pb-0.5">
				{/* One line, never two states: the arming window is shorter than the
				    time it takes to read a row, so a "not yet" hint would only flicker. */}
				<p className="min-w-0 flex-1 text-fg-3 leading-snug">{t("rateLimits.panelSubtitle")}</p>
				<button
					type="button"
					onClick={onOpenSettings}
					className="shrink-0 rounded text-accent hover:text-accent-emphasis active:scale-[0.96] transition-[color,scale]"
				>
					{t("rateLimits.manageAccounts")}
				</button>
			</div>
			{blocks.map((block) => {
				// One tab stop per group: the current default, or the first row.
				const stop = block.rows.find((row) => row.isDefault) ?? block.rows[0];
				return (
					<div key={block.kind} className="space-y-1">
						<div className="px-2 text-fg-muted text-micro font-semibold uppercase tracking-wider">
							{SOURCE_NAMES[block.kind] ?? block.kind}
						</div>
						<div role="radiogroup" aria-label={SOURCE_NAMES[block.kind] ?? block.kind} className="space-y-1">
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
		</div>
	);
}
