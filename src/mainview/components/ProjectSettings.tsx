import { useEffect } from "react";
import { getTaskTitle, hasGitWorkflow, repoConfigEnabled } from "../../shared/types";
import { useT } from "../i18n";
import ImportConversationsModal from "./ImportConversationsModal";
import { BackIcon } from "./HeaderIcons";
import { handleTabListKeyDown } from "./project-settings/tab-list-keys";
import { ProjectSettingsControllerContext, useProjectSettingsController, type ProjectSettingsProps } from "../settings-sections/project-controller";
import type { ProjectSettingsTab } from "../settings-sections/registry";
import { SettingsCategoryPage, useRegisteredSettingsSections } from "../settings-sections/SettingsCategoryPage";
import { SectionDirtyProvider, useSectionDirtyHost } from "../settings-sections/section-dirty";

function ProjectSettings({ navigate: _navigate, navigationGuardRef, ...props }: ProjectSettingsProps) {
	const t = useT();
	const controller = useProjectSettingsController(props);
	const sections = useRegisteredSettingsSections();
	// The unsaved-changes guard stays with the page: tab bodies only report into it.
	const dirtyHost = useSectionDirtyHost();
	const { isDirty, save } = dirtyHost;
	useEffect(() => {
		if (!navigationGuardRef) return;
		navigationGuardRef.current = { isDirty, onSave: save };
		return () => {
			navigationGuardRef.current = null;
		};
	}, [navigationGuardRef, isDirty, save]);

	if (!controller) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-danger text-base">{t("project.notFound")}</span>
			</div>
		);
	}

	const { project, projectId, tasks, initialWorktreeTaskId, activeTab, setActiveTab, automationsTabHidden, importingConversations, setImportingConversations } = controller;
	const tabAvailable = activeTab === "automations"
		? !automationsTabHidden
		: activeTab === "worktree"
			? hasGitWorkflow(project)
			: true;
	const tabButtonProps = (tab: ProjectSettingsTab) => ({
		role: "tab",
		"aria-selected": activeTab === tab,
		tabIndex: activeTab === tab ? 0 : -1,
		onClick: () => setActiveTab(tab),
		className: `flex-1 px-4 py-2 text-sm font-medium rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] ${
			activeTab === tab
				? "bg-accent-fill text-white shadow-sm"
				: "text-fg-3 hover:text-fg-2 hover:bg-elevated"
		}`,
	});

	const dirty = dirtyHost.isDirty();

	return (
		<ProjectSettingsControllerContext.Provider value={controller}>
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-3xl mx-auto bg-raised/80 backdrop-blur-sm border border-edge/50 rounded-2xl p-6 space-y-7">

					{/* Back button when navigated from a task */}
					{initialWorktreeTaskId && (() => {
						const backTask = tasks.find((t) => t.id === initialWorktreeTaskId);
						return backTask ? (
							<button
								type="button"
								onClick={() => _navigate({ screen: "project", projectId, activeTaskId: initialWorktreeTaskId })}
								className="header-anim flex items-center gap-1.5 text-fg-3 hover:text-fg-2 text-sm transition-colors -mt-1 -mb-3"
							>
								<BackIcon className="w-3.5 h-3.5 flex-shrink-0" />
								<span className="truncate max-w-xs">{getTaskTitle(backTask)}</span>
							</button>
						) : null;
					})()}

					{/* 3-tab selector */}
					<div>
						<div role="tablist" aria-label={t("projectSettings.tabsAria")} className="flex gap-1 bg-elevated/50 rounded-xl p-1 mb-1" onKeyDown={handleTabListKeyDown}>
							<button type="button" {...tabButtonProps("global")}>
								{t("projectSettings.tabGlobal")}
							</button>
							{/* Operations boards have no git repo — the Project/Worktree config
							    tabs are git-only, so hide them and keep just the Board tab. */}
							{project.kind !== "virtual" && (
								<button type="button" {...tabButtonProps("project")}>
									{t("projectSettings.tabProject")}
								</button>
							)}
							{/* Worktree settings mean nothing once the git workflow is off. */}
							{hasGitWorkflow(project) && (
								<button type="button" {...tabButtonProps("worktree")}>
									{t("projectSettings.tabWorktree")}
								</button>
							)}
							{!automationsTabHidden && (
								<button type="button" {...tabButtonProps("automations")}>
									{t("automations.tabLabel")}
								</button>
							)}
						</div>
						<p className="text-fg-muted text-xs px-1">
							{activeTab === "global" && t("projectSettings.tabGlobalDesc")}
							{activeTab === "project" && (repoConfigEnabled(project)
								? t("projectSettings.tabProjectDesc")
								: t("projectSettings.tabProjectDescNoRepo"))}
							{activeTab === "worktree" && t("projectSettings.tabWorktreeDesc")}
							{activeTab === "automations" && t("automations.tabDesc")}
						</p>
					</div>

					{/* Each tab's body is a region of the settings-sections slot; only a tab the
					    bar offers renders, so a hidden or git-less tab never shows a stale body. */}
					{tabAvailable && (
						<SectionDirtyProvider reporter={dirtyHost.reporter}>
							<SettingsCategoryPage region={`projectSettings.${activeTab}`} sections={sections} className="" />
						</SectionDirtyProvider>
					)}

				</div>
			</div>
			{dirty && (
				<div role="status" className="border-t border-edge/60 bg-overlay/95 backdrop-blur px-7 py-4 motion-safe:animate-slide-up">
					<div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
						<p className="text-sm text-fg-2">{t("unsavedChanges.banner")}</p>
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={dirtyHost.discard}
								className="px-4 py-2 text-sm font-medium rounded-xl text-fg-2 outline-none hover:text-fg hover:bg-overlay-hover focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
							>
								{t("unsavedChanges.discard")}
							</button>
							<button
								type="button"
								onClick={() => void dirtyHost.save()}
								disabled={dirtyHost.saving || dirtyHost.blocked}
								className="px-5 py-2.5 bg-accent-fill text-white text-sm font-semibold rounded-xl outline-none hover:bg-accent-fill-hover focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base disabled:opacity-50 shadow-lg shadow-accent/20 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.96]"
							>
								{dirtyHost.saving ? t("projectSettings.saving") : t("unsavedChanges.save")}
							</button>
						</div>
					</div>
				</div>
			)}
			{importingConversations && (
				<ImportConversationsModal project={project} onClose={() => setImportingConversations(false)} />
			)}
		</div>
		</ProjectSettingsControllerContext.Provider>
	);
}

export default ProjectSettings;
