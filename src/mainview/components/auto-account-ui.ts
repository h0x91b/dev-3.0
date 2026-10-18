import { useEffect, useState } from "react";
import type { AccountPickReason, AssessedAccount, AutoAccountPreview } from "../../shared/account-routing";
import type { AgentAccountKind } from "../../shared/agent-accounts";
import { isRoutableAccountKind } from "../../shared/agent-accounts";
import { formatResetDelta } from "../../shared/rate-limits";
import type { useT } from "../i18n";
import { api } from "../rpc";

type T = ReturnType<typeof useT>;

/** Statuses that keep a login out of Auto for good (not just right now). */
const NEVER_AUTO: ReadonlySet<AssessedAccount["status"]> = new Set(["metered", "excluded", "duplicate", "no-limits"]);

/** Logins Auto could choose between — the Auto row only earns its place at two. */
export function autoCandidateTotal(preview: AutoAccountPreview | null): number {
	return preview ? preview.assessed.filter((a) => !NEVER_AUTO.has(a.status)).length : 0;
}

/** What Auto would pick right now, refreshed on every new limit reading. */
export function useAutoAccountPreview(
	kind: AgentAccountKind | null,
	projectId: string | undefined,
	enabled: boolean,
): AutoAccountPreview | null {
	const [preview, setPreview] = useState<AutoAccountPreview | null>(null);
	const routable = isRoutableAccountKind(kind);
	useEffect(() => {
		if (!enabled || !routable) return;
		let cancelled = false;
		const load = () => {
			// Promise.resolve also absorbs a missing RPC on plain-object api mocks.
			Promise.resolve()
				.then(() => api.request.previewAutoAccount({ kind: kind as AgentAccountKind, projectId: projectId ?? null }))
				.then((next) => {
					if (!cancelled) setPreview(next ?? null);
				})
				.catch(() => {});
		};
		load();
		window.addEventListener("rpc:agentRateLimitsUpdated", load);
		window.addEventListener("dev3:agentAccountsChanged", load);
		return () => {
			cancelled = true;
			window.removeEventListener("rpc:agentRateLimitsUpdated", load);
			window.removeEventListener("dev3:agentAccountsChanged", load);
		};
	}, [enabled, routable, kind, projectId]);
	return enabled && routable ? preview : null;
}

const pct = (n: number) => Math.round(n);

/** One line saying why Auto picks (or would pick) the account it does. */
export function autoReasonText(t: T, reason: AccountPickReason, now = Date.now()): string {
	switch (reason.code) {
		case "only":
			return reason.short == null ? t("launch.accountAutoReasonOnlyNoData") : t("launch.accountAutoReasonOnly", { short: pct(reason.short) });
		case "lowest-short":
			return t("launch.accountAutoReasonLowest", { short: pct(reason.short), next: pct(reason.nextShort) });
		case "pace": {
			const delta = formatResetDelta(reason.weeklyResetsAt, now);
			return delta
				? t("launch.accountAutoReasonPace", { short: pct(reason.short), left: pct(reason.weeklyLeft), time: delta })
				: t("launch.accountAutoReasonTie", { short: pct(reason.short) });
		}
		case "tie-short":
			return t("launch.accountAutoReasonTie", { short: pct(reason.short) });
		case "unlimited":
			return t("launch.accountAutoReasonUnlimited");
		case "unknown":
			return t("launch.accountAutoReasonUnknown");
		case "none": {
			const delta = formatResetDelta(reason.earliestResetAt, now);
			return delta ? t("launch.accountAutoReasonNone", { time: delta }) : t("launch.accountAutoReasonNoneNever");
		}
	}
}
