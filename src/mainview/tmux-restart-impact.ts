import type { StaleTmuxServer, TmuxRestartImpact } from "../shared/types";
import type { TFunction, TranslationKey } from "./i18n";

/** The launch notice for each way the live tmux server has gone stale. */
export const STALE_TMUX_SERVER_MESSAGE: Record<StaleTmuxServer, TranslationKey> = {
	deleted: "terminal.staleTmuxServerDeleted",
	elsewhere: "terminal.staleTmuxServerElsewhere",
	incompatible: "terminal.staleTmuxServerIncompatible",
};

/** The restart confirm's account of what dies: terminal counts, then every agent caught mid-turn. */
export function describeTmuxRestartImpact(impact: TmuxRestartImpact | null, t: TFunction): string {
	if (!impact) return t("terminal.restartImpactUnknown");
	const lines = [t.plural("terminal.restartImpactTasks", impact.taskTerminals)];
	if (impact.otherSessions > 0) lines.push(t.plural("terminal.restartImpactOther", impact.otherSessions));
	if (impact.working.length === 0) {
		lines.push(t("terminal.restartImpactIdle"));
		return lines.join(" ");
	}
	const tasks = impact.working.map(
		(task) => `• ${t("terminal.restartImpactTask", { seq: task.seqLabel, title: task.title, project: task.projectName })}`,
	);
	return [lines.join(" "), t.plural("terminal.restartImpactWorking", impact.working.length), ...tasks].join("\n");
}
