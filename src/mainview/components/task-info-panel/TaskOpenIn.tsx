import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { toast } from "../../toast";
import { createPortal } from "react-dom";
import type { Project, Task } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import OpenInMenu from "../OpenInMenu";
import Tooltip from "../Tooltip";
import { OpenInIcon, FileTreeIcon } from "../TaskIcons";

interface TaskOpenInProps {
	task: Task;
	project: Project;
	isTaskActive: boolean;
	showFileBrowser?: boolean;
}

export default function TaskOpenIn({ task, project, isTaskActive, showFileBrowser = true }: TaskOpenInProps) {
	const t = useT();
	const openInBtnRef = useRef<HTMLButtonElement>(null);
	const [openInMenuOpen, setOpenInMenuOpen] = useState(false);
	const [openInMenuPos, setOpenInMenuPos] = useState({ top: 0, left: 0 });
	const [yaziInstallPopup, setYaziInstallPopup] = useState(false);
	const [yaziCopied, setYaziCopied] = useState(false);
	const [yaziInstallCmd, setYaziInstallCmd] = useState("");
	const [yaziLinuxHint, setYaziLinuxHint] = useState(false);

	function handleOpenInClick(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		if (openInBtnRef.current) {
			const rect = openInBtnRef.current.getBoundingClientRect();
			setOpenInMenuPos({ top: rect.bottom + 4, left: rect.left });
		}
		setOpenInMenuOpen(true);
	}

	async function handleFileBrowser() {
		if (!isTaskActive) {
			return;
		}

		try {
			const result = await api.request.openFileBrowser({ taskId: task.id, projectId: project.id });
			if (result && (result as { notInstalled?: boolean }).notInstalled) {
				setYaziInstallCmd((result as { installCommand?: string }).installCommand ?? "");
				setYaziLinuxHint(!!(result as { linuxHint?: boolean }).linuxHint);
				setYaziInstallPopup(true);
			}
		} catch (err) {
			toast.error(t("infoPanel.fileBrowserFailed", { error: String(err) }));
		}
	}

	if (!isTaskActive || !task.worktreePath) {
		return null;
	}

	return (
		<>
			<div className="relative flex-shrink-0">
				<Tooltip content={t("openIn.menuTitle")} detail={t("ttip.openIn.menu")}>
					<button
						ref={openInBtnRef}
						onClick={handleOpenInClick}
						className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-accent hover:text-accent-hover hover:bg-accent/15 border border-accent/30"
					>
						<OpenInIcon className="w-[1.05rem] h-[1.05rem]" />
						<span className="text-[0.6875rem] font-semibold">{t("openIn.menuTitle")}</span>
					</button>
				</Tooltip>
				{openInMenuOpen && (
					<OpenInMenu
						position={openInMenuPos}
						path={task.worktreePath}
						onClose={() => setOpenInMenuOpen(false)}
					/>
				)}
			</div>

			{showFileBrowser && (
				<div className="relative flex-shrink-0">
					<Tooltip content={t("header.fileBrowser")} detail={t("ttip.openIn.fileBrowser")}>
						<button
							onClick={handleFileBrowser}
							disabled={!isTaskActive}
							className={`task-anim flex items-center justify-center px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
								!isTaskActive
									? "text-fg-muted/50 cursor-not-allowed border border-edge/40"
									: "text-accent hover:text-accent-hover hover:bg-accent/15 border border-accent/30"
							}`}
							aria-label={t("header.fileBrowser")}
						>
							<FileTreeIcon className="w-[1.125rem] h-[1.125rem]" />
						</button>
					</Tooltip>
					{yaziInstallPopup && createPortal(
						<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setYaziInstallPopup(false)}>
							<div
								className="bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active p-5 max-w-lg w-full mx-4"
								onClick={(event) => event.stopPropagation()}
							>
								<div className="text-sm font-semibold text-fg mb-2">{t("fileBrowser.notInstalledTitle")}</div>
								<p className="text-fg-3 text-xs mb-3">{t("fileBrowser.notInstalledDesc")}</p>
								{yaziLinuxHint && <p className="text-fg-3 text-xs mb-2">{t("fileBrowser.linuxBrewHint")}</p>}
								<div className="flex items-center gap-2 mb-3">
									<code className="flex-1 text-warning bg-warning/10 px-3 py-2 rounded text-xs font-mono break-all">
										{yaziInstallCmd}
									</code>
									<Tooltip content={t("openIn.copyPath")} detail={t("ttip.infoPanel.copyPath")}>
									<button
										onClick={() => {
											navigator.clipboard.writeText(yaziInstallCmd);
											setYaziCopied(true);
											setTimeout(() => setYaziCopied(false), 2000);
										}}
										className="p-2 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg shrink-0"
										aria-label={t("openIn.copyPath")}
									>
										{yaziCopied ? (
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
								{yaziCopied && <p className="text-success text-xs mb-3">{t("requirements.copied")}</p>}
								<p className="text-fg-muted text-xs mb-3">{t("fileBrowser.clickAgainHint")}</p>
								<div className="flex justify-end">
									<button
										onClick={() => setYaziInstallPopup(false)}
										className="px-4 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors"
									>
										OK
									</button>
								</div>
							</div>
						</div>,
						document.body,
					)}
				</div>
			)}
		</>
	);
}
