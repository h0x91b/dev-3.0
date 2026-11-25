import type { AgentsStoreNotice } from "../shared/types";
import type { TFunction } from "./i18n";
import { OPEN_SETTINGS_SECTION_EVENT } from "./state";
import { toast } from "./toast";

/** Notices already shown on this page: the host both pushes a notice and serves it on mount. */
const shown = new Set<string>();

export function resetAgentsStoreNoticeToastForTests(): void {
	shown.clear();
}

/** agents.json was unreadable: say what dev3 did about it and where the unreadable bytes went. */
export function showAgentsStoreNoticeToast(notice: AgentsStoreNotice, t: TFunction): void {
	const key = `${notice.kind}:${notice.backupFile ?? ""}`;
	if (shown.has(key)) return;
	shown.add(key);
	const headline = t(notice.kind === "recovered" ? "toast.agentsStoreRecovered" : "toast.agentsStoreUnreadable");
	const backup = notice.backupFile ? ` ${t("toast.agentsStoreBackup", { file: notice.backupFile })}` : "";
	toast.warning(`${headline}${backup}`, {
		source: "settings",
		durationMs: Number.POSITIVE_INFINITY,
		actions: [
			{ label: t("toast.agentsStoreSettings"), onClick: () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: "agents" })) },
		],
	});
}
