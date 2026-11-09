import type { AgentFamily, CodingAgent } from "../../shared/types";
import { agentKey } from "../../shared/agent-adapters/families";
import { useT } from "../i18n";
import AgentAccountIndicator from "./AgentAccountIndicator";

/** What the picker needs of a saved pane: the wake screen's session state and the approval dialog's rows both fit. */
export interface ResumablePane {
	agentId: string | null;
	agentCmd: string;
	agentFamily?: AgentFamily | null;
	accountId?: string | null;
}

/** Only Claude panes take an account choice: a Codex conversation lives in its own account's home. */
export function isClaudePane(pane: ResumablePane): boolean {
	return paneKey(pane) === "claude";
}

/** A snapshot read off disk may lack its command; it must not take the recovery screen down with it. */
function paneKey(pane: ResumablePane): string {
	return agentKey(pane.agentCmd ?? "", pane.agentFamily ?? undefined);
}

/** The account a resume runs the first Claude pane on today; an old snapshot without one follows the task. */
export function savedResumeAccount(panes: readonly ResumablePane[], taskAccountId: string | null | undefined): string | null | undefined {
	const index = panes.findIndex(isClaudePane);
	if (index < 0) return undefined;
	const saved = panes[index].accountId;
	return saved === undefined && index === 0 ? taskAccountId : saved;
}

/**
 * The per-resume account line on the wake/recovery screen and the resume approval dialog.
 * `value` undefined shows the saved account; a pick goes to `onChange` and applies to
 * every Claude pane of this one resume. Renders nothing when no saved pane runs Claude.
 * The project-login row reports `undefined` ("no override"); a resume already keeps its saved account then.
 */
export default function ResumeAccountPicker({
	panes,
	agents,
	value,
	onChange,
	projectId,
}: {
	panes: readonly ResumablePane[];
	agents: readonly CodingAgent[];
	value: string | null | undefined;
	onChange: (accountId: string | null) => void;
	projectId?: string;
}) {
	const t = useT();
	const claudePane = panes.find(isClaudePane);
	const agent = claudePane ? agents.find((a) => a.id === claudePane.agentId) : undefined;
	if (!agent) return null;
	const keepsCodexAccount = panes.some((pane) => paneKey(pane) === "codex");
	return (
		<div data-testid="resume-account-picker" className="space-y-1">
			<div className="flex items-baseline gap-2 min-w-0 text-xs text-fg-3">
				<span className="shrink-0">{t("terminal.resumeAccount")}</span>
				<div className="min-w-0">
					<AgentAccountIndicator agent={agent} value={value} onSelect={(accountId) => accountId !== undefined && onChange(accountId)} allowAuto={false} subtitle={t("terminal.resumeAccountSubtitle")} projectId={projectId} />
				</div>
			</div>
			{keepsCodexAccount ? <p className="text-fg-muted text-xs">{t("terminal.resumeAccountCodexNote")}</p> : null}
		</div>
	);
}
