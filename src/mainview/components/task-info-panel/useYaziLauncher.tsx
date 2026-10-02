import { useState } from "react";
import { createPortal } from "react-dom";
import type { Project, Task } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { toast } from "../../toast";
import Tooltip from "../Tooltip";

/**
 * The yazi terminal file manager in a tmux pane beside the agent. It is the
 * secondary path now: the file explorer panel needs nothing installed, and this
 * is offered from its header menu for users who want yazi's file operations.
 */
export function useYaziLauncher(task: Task | undefined, project: Project | undefined) {
	const t = useT();
	const [installPopup, setInstallPopup] = useState(false);
	const [copied, setCopied] = useState(false);
	const [installCmd, setInstallCmd] = useState("");
	const [linuxHint, setLinuxHint] = useState(false);

	async function launch() {
		if (!task || !project) return;
		try {
			const result = await api.request.openFileBrowser({ taskId: task.id, projectId: project.id });
			if (result && (result as { notInstalled?: boolean }).notInstalled) {
				setInstallCmd((result as { installCommand?: string }).installCommand ?? "");
				setLinuxHint(!!(result as { linuxHint?: boolean }).linuxHint);
				setInstallPopup(true);
			}
		} catch (err) {
			toast.error(t("infoPanel.fileBrowserFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	const dialog = installPopup ? createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setInstallPopup(false)}>
			<div
				className="bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-5 max-w-lg w-full mx-4"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="text-sm font-semibold text-fg mb-2">{t("fileBrowser.notInstalledTitle")}</div>
				<p className="text-fg-3 text-xs mb-3">{t("fileBrowser.notInstalledDesc")}</p>
				{linuxHint && <p className="text-fg-3 text-xs mb-2">{t("fileBrowser.linuxBrewHint")}</p>}
				<div className="flex items-center gap-2 mb-3">
					<code className="flex-1 text-warning-strong bg-warning/10 px-3 py-2 rounded text-xs font-mono break-all">
						{installCmd}
					</code>
					<Tooltip content={t("openIn.copyPath")} detail={t("ttip.infoPanel.copyPath")}>
					<button
						onClick={() => {
							navigator.clipboard.writeText(installCmd);
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						}}
						className="p-2 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg shrink-0"
						aria-label={t("openIn.copyPath")}
					>
						{copied ? (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<polyline points="20 6 9 17 4 12" />
							</svg>
						) : (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
								<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
							</svg>
						)}
					</button>
					</Tooltip>
				</div>
				{copied && <p className="text-success text-xs mb-3">{t("requirements.copied")}</p>}
				<p className="text-fg-muted text-xs mb-3">{t("fileBrowser.clickAgainHint")}</p>
				<div className="flex justify-end">
					<button
						onClick={() => setInstallPopup(false)}
						className="px-4 py-1.5 rounded-lg bg-accent-fill text-white text-xs font-medium hover:bg-accent-fill-hover transition-colors"
					>
						OK
					</button>
				</div>
			</div>
		</div>,
		document.body,
	) : null;

	return { launch, dialog };
}
