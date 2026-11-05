import { useEffect, useState, type ReactNode } from "react";
import type { ProjectClaudeLogin } from "../../shared/agent-accounts";
import type { CodingAgent, NativeTaskAgent, Task } from "../../shared/types";
import { useT } from "../i18n";
import { api } from "../rpc";
import { useStreamerMode } from "../streamer-mode";
import { describeTaskAgentAccounts } from "../utils/taskAgentAccounts";
import { useAgentAccountsState } from "./AgentAccountIndicator";
import AgentLauncherBadge, { resolveAgentLauncherIcon } from "./AgentLauncherBadge";

const TAG_CLASS = "rounded px-1 text-dense font-semibold uppercase tracking-wider";

/**
 * Mount only while the hover surface is open: it fetches the account registry.
 * `frame` wraps the list only when it has rows, so a parent never shows an empty section.
 */
export function TaskAgentAccountsList({ task, agents, frame }: { task: Task; agents: CodingAgent[]; frame?: (list: ReactNode) => ReactNode }) {
	const t = useT();
	const streamer = useStreamerMode();
	const accounts = useAgentAccountsState(true);
	const [extraAgents, setExtraAgents] = useState<NativeTaskAgent[]>([]);
	useEffect(() => {
		if (task.terminalBackend !== "native") return;
		let cancelled = false;
		api.request
			.getNativeTaskAgents({ projectId: task.projectId, taskId: task.id })
			.then((res) => { if (!cancelled) setExtraAgents(res); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [task.terminalBackend, task.projectId, task.id]);
	const needsProjectLogin = describeTaskAgentAccounts(task, agents, null, null, extraAgents).some((r) => r.onSystemClaude);
	const [projectLogin, setProjectLogin] = useState<ProjectClaudeLogin | null | "pending">("pending");
	useEffect(() => {
		if (!needsProjectLogin) return;
		setProjectLogin("pending");
		let cancelled = false;
		api.request
			.getProjectClaudeLogin({ projectId: task.projectId })
			.then((res) => { if (!cancelled) setProjectLogin(res); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [needsProjectLogin, task.projectId]);
	const rows = describeTaskAgentAccounts(task, agents, accounts, needsProjectLogin ? projectLogin : null, extraAgents);
	if (rows.length === 0) return null;

	const list = (
		<div data-testid="task-agent-accounts" className="flex flex-col gap-1">
			{rows.map(({ key, agent, agentName, account, auto }) => (
				<div key={key} data-testid="task-agent-account-row" className="flex min-w-0 items-center gap-1.5 text-micro">
					{agent && resolveAgentLauncherIcon(agent) && <AgentLauncherBadge agent={agent} size={12} />}
					<span className="min-w-0 max-w-[40%] truncate text-fg-3" title={agentName}>{agentName}</span>
					{account.kind === "managed" && (
						<span className="min-w-0 truncate font-medium text-fg-2 streamer-private" title={streamer ? undefined : account.label}>{account.label}</span>
					)}
					{account.kind === "system" && (
						<span className="flex-shrink-0 text-fg-2">{t("taskAgents.systemLogin")}</span>
					)}
					{account.kind === "project" && (
						<span className="flex-shrink-0 text-fg-2">{t("taskAgents.projectLogin")}</span>
					)}
					{account.kind === "preset" && (
						<span className="flex-shrink-0 text-fg-2">{t("taskAgents.presetLogin")}</span>
					)}
					{account.kind === "deleted" && (
						<span className="text-fg-3 italic">{t("taskAgents.deleted")}</span>
					)}
					{account.kind === "default" && <span className="text-fg-3">{t("taskAgents.default")}</span>}
					{(account.kind === "managed" || account.kind === "system" || account.kind === "project") && account.email && (
						<span className="min-w-0 truncate text-fg-3 streamer-private" title={streamer ? undefined : account.email}>
							{account.email}
						</span>
					)}
					{(auto || (account.kind === "managed" && account.api)) && (
						<span className="ml-auto flex flex-shrink-0 gap-1">
							{auto && <span className={`${TAG_CLASS} bg-accent/15 text-accent`}>{t("taskAgents.auto")}</span>}
							{account.kind === "managed" && account.api && (
								<span className={`${TAG_CLASS} bg-raised text-fg-3`}>{t("taskAgents.api")}</span>
							)}
						</span>
					)}
				</div>
			))}
		</div>
	);
	return frame ? frame(list) : list;
}
