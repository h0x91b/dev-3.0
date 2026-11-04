import type { TFunction } from "./i18n";
import { api } from "./rpc";
import { OPEN_SETTINGS_SECTION_EVENT } from "./state";
import { toast } from "./toast";

export interface StaleAgentPathDetail {
	agentId: string;
	agentName: string;
	path: string;
	command: string;
}

/** A launch fell back to PATH over a gone pre-strict custom path: say so, and offer the reset in one click. */
export function showStaleAgentPathToast(detail: StaleAgentPathDetail, t: TFunction): void {
	const resetPath = async () => {
		try {
			await api.request.clearAgentBinaryPath({ agentId: detail.agentId });
			toast.success(t("toast.staleAgentPathResetDone", { agent: detail.agentName, command: detail.command }), { source: "settings" });
		} catch {
			toast.error(t("settings.agentPathResetFailed"), { source: "settings" });
		}
	};
	// The path stays out of the message: it names the user's home directory.
	toast.warning(t("toast.staleAgentPath", { agent: detail.agentName, command: detail.command }), {
		source: "settings",
		durationMs: 15_000,
		actions: [
			{ label: t("toast.staleAgentPathReset"), emphasis: true, onClick: () => void resetPath() },
			{ label: t("toast.staleAgentPathSettings"), onClick: () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: "agents" })) },
		],
	});
}
