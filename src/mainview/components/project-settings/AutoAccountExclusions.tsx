import { useEffect, useState } from "react";
import { exclusionKey } from "../../../shared/account-routing";
import type { AgentAccountsState, RoutableAccountKind } from "../../../shared/agent-accounts";
import type { Project } from "../../../shared/types";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import SettingsSection from "../global-settings/SettingsSection";
import { ToggleSwitch } from "./fields";

const KINDS: { kind: RoutableAccountKind; name: string }[] = [
	{ kind: "claude", name: "Claude Code" },
	{ kind: "codex", name: "Codex" },
];

interface Login {
	key: string;
	label: string;
	sub: string | null;
}

function subscriptionLogins(state: AgentAccountsState, kind: RoutableAccountKind, systemLabel: string): Login[] {
	const managed = state[kind].accounts
		.filter((a) => a.auth !== "api")
		.map((a) => ({ key: exclusionKey(kind, a.id), label: a.label, sub: a.identity?.email ?? null }));
	const identity = kind === "claude" ? state.claude.systemIdentity : state.codex.currentIdentity;
	return identity ? [...managed, { key: exclusionKey(kind, null), label: systemLabel, sub: identity.email }] : managed;
}

/**
 * Board tab: which subscription logins Auto may use for this project. Every
 * login is in by default; a switch turned off keeps that login away from this
 * project's Auto launches. Hidden until some harness has two logins to balance.
 */
export function AutoAccountExclusions({
	project,
	onSave,
}: {
	project: Project;
	onSave: (exclusions: string[]) => void;
}) {
	const t = useT();
	const [state, setState] = useState<AgentAccountsState | null>(null);
	useEffect(() => {
		let cancelled = false;
		Promise.resolve()
			.then(() => api.request.listAgentAccounts())
			.then((next) => {
				if (!cancelled) setState(next);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	if (!state) return null;
	const groups = KINDS.map(({ kind, name }) => ({
		kind,
		name,
		logins: subscriptionLogins(
			state,
			kind,
			kind === "claude" ? t("settings.accountsDefaultLogin", { dir: state.claude.systemConfigDir }) : t("settings.accountsUnmanaged"),
		),
	})).filter((group) => group.logins.length >= 2);
	if (groups.length === 0) return null;

	const excluded = new Set(project.autoAccountExclusions ?? []);
	const toggle = (key: string) => {
		const next = new Set(excluded);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		onSave([...next]);
	};

	return (
		<SettingsSection title={t("projectSettings.autoAccountsTitle")} description={t("projectSettings.autoAccountsDesc")}>
			<div className="space-y-4" data-testid="auto-account-exclusions">
				{groups.map((group) => (
					<div key={group.kind} className="space-y-2">
						<span className="block text-fg-2 text-sm font-semibold">{group.name}</span>
						{group.logins.map((login) => (
							<div key={login.key} className="flex items-center justify-between gap-4">
								<div className="min-w-0">
									<span className="block text-fg text-sm truncate streamer-private">{login.label}</span>
									{login.sub && login.sub !== login.label ? (
										<span className="block text-fg-3 text-xs truncate streamer-private">{login.sub}</span>
									) : null}
								</div>
								<ToggleSwitch
									checked={!excluded.has(login.key)}
									ariaLabel={login.label}
									onToggle={() => toggle(login.key)}
								/>
							</div>
						))}
					</div>
				))}
				<p className="text-fg-3 text-xs">{t("projectSettings.autoAccountsApiNote")}</p>
			</div>
		</SettingsSection>
	);
}
