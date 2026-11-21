import { getTaskTitle, hasGitWorkflow, repoConfigEnabled, type ArtifactTemplateMode, type CustomColumn, type Label } from "../../shared/types";
import AutomationsPanel from "../components/AutomationsPanel";
import SettingsSection from "../components/global-settings/SettingsSection";
import ArtifactTemplateFolderField from "../components/global-settings/ArtifactTemplateFolderField";
import { ARTIFACT_TEMPLATE_MODE_LABELS } from "../components/global-settings/BehaviorSettingsSection";
import ProjectSpacesField from "../components/ProjectSpacesField";
import { ConfigForm } from "../components/project-settings/ConfigForm";
import { CustomColumnRow } from "../components/project-settings/CustomColumnRow";
import { LabelRow } from "../components/project-settings/LabelRow";
import { ProjectNameField } from "../components/project-settings/ProjectNameField";
import { decodeGitHubAccountValue, encodeGitHubAccountValue, formatGitHubAccountLabel } from "../components/project-settings/config-values";
import { AddRowButton, EmptyHint, ToggleSwitch, WarningNote } from "../components/project-settings/fields";
import { AutoAccountExclusions } from "../components/project-settings/AutoAccountExclusions";
import type { Context, Fiber } from "cordis";
import type { ComponentType } from "react";
import type { BuiltinPlugin } from "../plugins/runtime";
import { handleTabListKeyDown } from "../components/project-settings/tab-list-keys";
import { useProjectSettingsContext, type WorktreeSubTab } from "./project-controller";
import type { ProjectSettingsTab } from "./registry";
import { useSectionDirty } from "./section-dirty";
// Defines the `settingsSections` slot on the app root before the built-ins install.
import "./registry";

// Each tab body is the page's old markup over the page controller (internal state behind a
// public placement — recorded tech debt, `decisions/2026/11/21/settings-sections-slot.md`).
function BuiltinBoardTab() {
	const { project, t, projectId, labelTaskCounts, setImportingConversations, labelCreationHidden, labelSaving, columnSaving, draggedLabelId, setDraggedLabelId, labelDropTarget, setLabelDropTarget, availableAgents, globalArtifactTemplate, handleRenameProject, handleArtifactTemplateChange, handleAutoAccountExclusions, handleBoardCopyChange, handleToggleGitWorkflow, handleToggleStorage, handleToggleSensitive, handleAddLabel, handleUpdateLabel, handleDeleteLabel, moveLabelByStep, handleLabelDragOver, handleLabelDrop, handleAddColumn, handleUpdateColumn, handleDeleteColumn } = useProjectSettingsContext();
	return (
			<div data-help-id="project-settings.board">
				<SettingsSection
					title={t("projectSettings.projectName")}
					description={t("projectSettings.projectNameDesc")}
				>
				<ProjectNameField project={project} onRename={handleRenameProject} />
				</SettingsSection>

				<SettingsSection
					title={t("customColumns.settingsTitle")}
					description={t("customColumns.settingsDesc")}
				>
				<div>
					<div className="space-y-2">
						{(project.customColumns ?? []).map((col: CustomColumn) => (
							<CustomColumnRow
								key={col.id}
								column={col}
								saving={columnSaving === col.id}
								onUpdate={(name, color, llmInstruction, agentConfig) => handleUpdateColumn(col.id, name, color, llmInstruction, agentConfig)}
								onDelete={() => handleDeleteColumn(col.id)}
								availableAgents={availableAgents}
								projectId={projectId}
							/>
						))}
						{(project.customColumns ?? []).length === 0 && (
							<EmptyHint>
								{t("customColumns.noColumns")}
								<span className="block text-xs mt-1">{t("customColumns.noColumnsHint")}</span>
							</EmptyHint>
						)}
					</div>
					<AddRowButton onClick={handleAddColumn} disabled={columnSaving !== null}>
						{t("customColumns.addColumn")}
					</AddRowButton>
				</div>
				</SettingsSection>

				<SettingsSection
					title={t("labels.settingsTitle")}
					description={t("labels.settingsDesc")}
				>
				<div>
					<div className="space-y-2">
						{(project.labels ?? []).map((label: Label, index: number) => (
							<LabelRow
								key={label.id}
								label={label}
								saving={labelSaving === label.id}
								onUpdate={(name, color) => handleUpdateLabel(label.id, name, color)}
								onDelete={() => handleDeleteLabel(label.id)}
								nameLabel={t("labels.labelName")}
								deleteLabel={t("labels.deleteLabel")}
								taskCount={labelTaskCounts.get(label.id) ?? 0}
								reorderEnabled={(project.labels ?? []).length > 1}
								dragged={draggedLabelId === label.id}
								dropSide={labelDropTarget?.labelId === label.id ? labelDropTarget.side : null}
								isFirst={index === 0}
								isLast={index === (project.labels ?? []).length - 1}
								onDragStart={() => setDraggedLabelId(label.id)}
								onDragOver={(e) => handleLabelDragOver(e, label.id)}
								onDragLeave={() => setLabelDropTarget((cur) => (cur?.labelId === label.id ? null : cur))}
								onDrop={(e) => handleLabelDrop(e, label.id)}
								onDragEnd={() => {
									setDraggedLabelId(null);
									setLabelDropTarget(null);
								}}
								onMoveUp={() => moveLabelByStep(label.id, -1)}
								onMoveDown={() => moveLabelByStep(label.id, 1)}
							/>
						))}
						{(project.labels ?? []).length === 0 && (
							<EmptyHint>{t("labels.noLabels")}</EmptyHint>
						)}
					</div>
					{!labelCreationHidden && (
						<AddRowButton onClick={handleAddLabel} disabled={labelSaving !== null}>
							{t("labels.addLabel")}
						</AddRowButton>
					)}
				</div>
				</SettingsSection>

				<SettingsSection
					title={t("spaces.sectionTitle")}
					description={t("spaces.sectionDesc")}
				>
				<ProjectSpacesField projectId={project.id} />
				</SettingsSection>

				{project.kind !== "virtual" && (
					<SettingsSection
						title={t("boardCopy.sectionTitle")}
						description={t("boardCopy.sectionDesc")}
					>
					<div className="space-y-4">
						<div className="flex items-center justify-between gap-4">
							<div>
								<span className="block text-fg text-sm font-semibold mb-1">{t("boardCopy.toggle")}</span>
								<p className="text-fg-3 text-sm">{t("boardCopy.toggleHint")}</p>
							</div>
							<ToggleSwitch
								checked={project.boardCopy === true}
								ariaLabel={t("boardCopy.toggle")}
								onToggle={() => void handleBoardCopyChange({ boardCopy: project.boardCopy !== true })}
							/>
						</div>
						{project.boardCopy === true && (
							<div className="flex items-center justify-between gap-4">
								<div>
									<span className="block text-fg text-sm font-semibold mb-1">{t("boardCopy.messages")}</span>
									<p className="text-fg-3 text-sm">{t("boardCopy.messagesHint")}</p>
								</div>
								<ToggleSwitch
									checked={project.boardCopyMessages === true}
									ariaLabel={t("boardCopy.messages")}
									onToggle={() => void handleBoardCopyChange({ boardCopyMessages: project.boardCopyMessages !== true })}
								/>
							</div>
						)}
					</div>
					</SettingsSection>
				)}

				{project.kind !== "virtual" && (
					<SettingsSection
						title={t("projectStorage.sectionTitle")}
						description={t("projectStorage.sectionDesc")}
					>
						<div className="flex items-center justify-between gap-4">
							<div>
								<span className="block text-fg text-sm font-semibold mb-1">{t("projectStorage.toggle")}</span>
								<p className="text-fg-3 text-sm">{t("projectStorage.toggleHint")}</p>
							</div>
							<ToggleSwitch
								checked={project.storageRoot === "project"}
								ariaLabel={t("projectStorage.toggle")}
								onToggle={() => void handleToggleStorage(project.storageRoot === "project" ? "home" : "project")}
							/>
						</div>
					</SettingsSection>
				)}

				{hasGitWorkflow(project) && (
					<SettingsSection
						title={t("projectSettings.importConversations")}
						description={t("projectSettings.importConversationsDesc")}
					>
					<button
						type="button"
						onClick={() => setImportingConversations(true)}
						className="px-4 py-2 bg-raised border border-edge rounded-xl text-fg-2 text-sm hover:border-edge-active hover:text-fg transition-colors"
					>
						{t("projectSettings.importConversationsBtn")}
					</button>
					</SettingsSection>
				)}

				{project.kind !== "virtual" && (
					<SettingsSection
						title={t("projectSettings.groupGitWorkflow")}
						description={t("projectSettings.groupGitWorkflowDesc")}
					>
					<div className="flex items-center justify-between gap-4">
						<div>
							<span className="block text-fg text-sm font-semibold mb-1">
								{t("projectSettings.gitWorkflow")}
							</span>
							<p className="text-fg-3 text-sm">
								{hasGitWorkflow(project)
									? t("projectSettings.gitWorkflowOnHint")
									: t("projectSettings.gitWorkflowOffHint")}
							</p>
						</div>
						<ToggleSwitch
							checked={hasGitWorkflow(project)}
							ariaLabel={t("projectSettings.gitWorkflow")}
							onToggle={() => void handleToggleGitWorkflow(!hasGitWorkflow(project))}
						/>
					</div>
					</SettingsSection>
				)}

				<SettingsSection
					title={t("projectSettings.artifactTemplate")}
					description={t("projectSettings.artifactTemplateDesc")}
				>
				<select
					id="project-artifact-template"
					aria-label={t("projectSettings.artifactTemplate")}
					value={project.artifactTemplate ?? "inherit"}
					onChange={(e) => void handleArtifactTemplateChange({ artifactTemplate: e.target.value as ArtifactTemplateMode | "inherit" })}
					className="w-full sm:w-auto px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
				>
					<option value="inherit">
						{t("projectSettings.artifactTemplateInherit", { value: t(ARTIFACT_TEMPLATE_MODE_LABELS[globalArtifactTemplate.mode]) })}
					</option>
					{(["on", "off", "custom"] as const).map((mode) => (
						<option key={mode} value={mode}>{t(ARTIFACT_TEMPLATE_MODE_LABELS[mode])}</option>
					))}
				</select>
				{project.artifactTemplate === "custom" && (
					<div className="mt-4">
						<ArtifactTemplateFolderField
							value={project.artifactTemplatePath ?? ""}
							placeholderPath={globalArtifactTemplate.path}
							projectId={projectId}
							onChange={(path) => void handleArtifactTemplateChange({ artifactTemplatePath: path })}
						/>
					</div>
				)}
				</SettingsSection>

				<AutoAccountExclusions project={project} onSave={(next) => void handleAutoAccountExclusions(next)} />

				<SettingsSection
					title={t("projectSettings.groupPrivacy")}
					description={t("projectSettings.groupPrivacyDesc")}
				>
				<div className="flex items-center justify-between gap-4">
					<div>
						<span className="block text-fg text-sm font-semibold mb-1">
							{t("projectSettings.sensitive")}
						</span>
						<p className="text-fg-3 text-sm">
							{t("projectSettings.sensitiveDesc")}
						</p>
					</div>
					<ToggleSwitch
						checked={project.sensitive ?? false}
						ariaLabel={t("projectSettings.sensitive")}
						onToggle={() => void handleToggleSensitive(!(project.sensitive ?? false))}
					/>
				</div>
				</SettingsSection>
			</div>
	);
}

function BuiltinProjectConfigTab() {
	const { project, t, projectId, projectConfig, setProjectConfig, savingProject, githubStatus, envTextError, setEnvTextError, configFileOverride, aiReviewAgentId, setAiReviewAgentId, aiReviewConfigId, setAiReviewConfigId, aiReviewPrompt, setAiReviewPrompt, availableAgents, reviewModePrompt, setReviewModePrompt, coordinatorPrompt, setCoordinatorPrompt, inheritedReviewModePrompt, inheritedCoordinatorPrompt, handleToggleUseRepoConfig, handleSaveProjectConfig, githubAccounts, activeGitHubAccount, selectedGitHubValue, selectedGitHubMissing, projectDirty, discardProjectConfig } = useProjectSettingsContext();
	useSectionDirty({ dirty: projectDirty, saving: savingProject, blocked: envTextError, save: handleSaveProjectConfig, discard: discardProjectConfig });
	return (
		<>
			{project.kind === "virtual" ? (
				<p className="text-fg-muted text-sm italic">{t("projectSettings.virtualNoGitConfig")}</p>
			) : (
				<div className="space-y-7" data-help-id="project-settings.project">
					<SettingsSection
						title={t("projectSettings.groupRepoConfig")}
						description={t("projectSettings.groupRepoConfigDesc")}
					>
					<div className="flex items-center justify-between gap-4">
						<div>
							<span className="block text-fg text-sm font-semibold mb-1">
								{t("projectSettings.useRepoConfig")}
							</span>
							<p className="text-fg-3 text-sm">
								{repoConfigEnabled(project)
									? t("projectSettings.useRepoConfigOnHint")
									: t("projectSettings.useRepoConfigOffHint")}
							</p>
						</div>
						<ToggleSwitch
							checked={repoConfigEnabled(project)}
							ariaLabel={t("projectSettings.useRepoConfig")}
							onToggle={() => void handleToggleUseRepoConfig(!repoConfigEnabled(project))}
						/>
					</div>
					</SettingsSection>
	
					{!repoConfigEnabled(project) ? (
						<WarningNote>
							{configFileOverride
								? t("projectSettings.repoConfigIgnoredWithFile", { file: configFileOverride })
								: t("projectSettings.repoConfigIgnored")}
						</WarningNote>
					) : configFileOverride && (
						<WarningNote>
							{configFileOverride.includes("local")
								? t("projectSettings.projectOverriddenByLocal", { file: configFileOverride })
								: t("projectSettings.projectOverriddenByRepo", { file: configFileOverride })}
						</WarningNote>
					)}
					<ConfigForm
						config={projectConfig}
						onChange={setProjectConfig}
						projectId={projectId}
						projectPath={project.path}
						envStorageScope="project"
						onEnvErrorChange={setEnvTextError}
					/>
	
					<SettingsSection
						title={t("projectSettings.groupIntegrations")}
						description={t("projectSettings.groupIntegrationsDesc")}
					>
					<div className="space-y-2">
						<div>
							<label htmlFor="project-github-account" className="block text-fg text-sm font-semibold mb-1">
								{t("projectSettings.githubAccount")}
							</label>
							<p className="text-fg-3 text-sm">
								{t("projectSettings.githubAccountDesc")}
							</p>
						</div>
						<select
							id="project-github-account"
							aria-label={t("projectSettings.githubAccount")}
							value={selectedGitHubValue}
							onChange={(event) => {
								const nextValue = event.target.value;
								setProjectConfig((current) => ({
									...current,
									...(nextValue
										? decodeGitHubAccountValue(nextValue)
										: { githubAuthHost: null, githubAuthLogin: null }),
								}));
							}}
							disabled={githubStatus?.authStatus !== "authenticated"}
							className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none focus:border-accent/40 transition-colors disabled:opacity-60 disabled:cursor-not-allowed streamer-private"
						>
							<option value="">
								{activeGitHubAccount
									? t("projectSettings.githubAccountUseActive", {
										account: formatGitHubAccountLabel(activeGitHubAccount, githubAccounts),
									})
									: t("projectSettings.githubAccountUseActiveUnknown")}
							</option>
							{githubAccounts.map((account) => (
								<option key={encodeGitHubAccountValue(account)} value={encodeGitHubAccountValue(account)}>
									{formatGitHubAccountLabel(account, githubAccounts)}
								</option>
							))}
						</select>
						{githubStatus?.authStatus === "not_installed" && (
							<p className="text-fg-muted text-xs">
								{t("projectSettings.githubAccountNotInstalled")}
							</p>
						)}
						{githubStatus?.authStatus === "not_authenticated" && (
							<p className="text-fg-muted text-xs">
								{t("projectSettings.githubAccountNotAuthenticated")}
							</p>
						)}
						{selectedGitHubMissing && (
							<p className="text-danger text-xs">
								{t("projectSettings.githubAccountMissing")}
							</p>
						)}
					</div>
	
					{/* AI Review Column */}
					<div className="space-y-4">
						<div>
							<span className="block text-fg text-sm font-semibold mb-1">
								{t("projectSettings.aiReview")}
							</span>
							<p className="text-fg-3 text-sm">
								{t("projectSettings.aiReviewDesc")}
							</p>
						</div>
						<div className="space-y-3 pl-1">
							<div className="flex items-center gap-3">
								<label htmlFor="ai-review-agent" className="text-fg-2 text-sm w-28 flex-shrink-0">{t("projectSettings.aiReviewAgent")}</label>
								<select
									id="ai-review-agent"
									value={aiReviewAgentId}
									onChange={(e) => {
										setAiReviewAgentId(e.target.value);
										const agent = availableAgents.find((a) => a.id === e.target.value);
										if (agent?.configurations?.length) {
											setAiReviewConfigId(agent.configurations[0].id);
										}
									}}
									className="flex-1 px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
								>
									{availableAgents.map((a) => (
										<option key={a.id} value={a.id}>{a.name}</option>
									))}
								</select>
							</div>
							<div className="flex items-center gap-3">
								<label htmlFor="ai-review-config" className="text-fg-2 text-sm w-28 flex-shrink-0">{t("projectSettings.aiReviewConfig")}</label>
								<select
									id="ai-review-config"
									value={aiReviewConfigId}
									onChange={(e) => setAiReviewConfigId(e.target.value)}
									className="flex-1 px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
								>
									{(availableAgents.find((a) => a.id === aiReviewAgentId)?.configurations ?? []).map((c) => (
										<option key={c.id} value={c.id}>{c.name || c.id}</option>
									))}
								</select>
							</div>
							<div>
								<label htmlFor="ai-review-prompt" className="block text-fg-2 text-sm mb-2">{t("projectSettings.aiReviewPrompt")}</label>
								<textarea
									id="ai-review-prompt"
									value={aiReviewPrompt}
									onChange={(e) => setAiReviewPrompt(e.target.value)}
									rows={5}
									placeholder={t("projectSettings.aiReviewPromptPlaceholder")}
									autoCapitalize="off"
									autoCorrect="off"
									spellCheck={false}
									className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
								/>
							</div>
						</div>
					</div>
	
					{/* Review toggle prompt (create-task popup) */}
					<div className="space-y-4">
						<div>
							<span className="block text-fg text-sm font-semibold mb-1">
								{t("projectSettings.reviewModePrompt")}
							</span>
							<p className="text-fg-3 text-sm">
								{t("projectSettings.reviewModePromptDesc")}
							</p>
						</div>
						<div className="space-y-3 pl-1">
							<textarea
								id="project-review-mode-prompt"
								aria-label={t("projectSettings.reviewModePrompt")}
								value={reviewModePrompt}
								onChange={(e) => setReviewModePrompt(e.target.value)}
								rows={8}
								placeholder={inheritedReviewModePrompt}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
							/>
							<div className="flex items-center gap-3">
								<button
									type="button"
									onClick={() => setReviewModePrompt(reviewModePrompt.trim() ? "" : inheritedReviewModePrompt)}
									className="text-sm text-fg-3 hover:text-accent transition-colors px-3 py-1.5 rounded-lg border border-edge hover:border-accent/30"
								>
									{reviewModePrompt.trim()
										? t("projectSettings.reviewModePromptReset")
										: t("projectSettings.reviewModePromptCopyInherited")}
								</button>
								<span className="text-fg-muted text-xs">
									{reviewModePrompt.trim()
										? t("projectSettings.reviewModePromptOverride")
										: t("projectSettings.reviewModePromptInherited")}
								</span>
							</div>
						</div>
					</div>
					{/* Coordinator task-type prompt (create-task popup) */}
					<div className="space-y-4">
						<div>
							<span className="block text-fg text-sm font-semibold mb-1">
								{t("projectSettings.coordinatorPrompt")}
							</span>
							<p className="text-fg-3 text-sm">
								{t("projectSettings.coordinatorPromptDesc")}
							</p>
						</div>
						<div className="space-y-3 pl-1">
							<textarea
								id="project-coordinator-prompt"
								aria-label={t("projectSettings.coordinatorPrompt")}
								value={coordinatorPrompt}
								onChange={(e) => setCoordinatorPrompt(e.target.value)}
								rows={8}
								placeholder={inheritedCoordinatorPrompt}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
							/>
							<div className="flex items-center gap-3">
								<button
									type="button"
									onClick={() => setCoordinatorPrompt(coordinatorPrompt.trim() ? "" : inheritedCoordinatorPrompt)}
									className="text-sm text-fg-3 hover:text-accent transition-colors px-3 py-1.5 rounded-lg border border-edge hover:border-accent/30"
								>
									{coordinatorPrompt.trim()
										? t("projectSettings.coordinatorPromptReset")
										: t("projectSettings.coordinatorPromptCopyInherited")}
								</button>
								<span className="text-fg-muted text-xs">
									{coordinatorPrompt.trim()
										? t("projectSettings.coordinatorPromptOverride")
										: t("projectSettings.coordinatorPromptInherited")}
								</span>
							</div>
						</div>
					</div>
					</SettingsSection>
				</div>
			)}
		</>
	);
}

function BuiltinWorktreeTab() {
	const { project, t, projectId, worktreeSubTab, setWorktreeSubTab, selectedWorktreeTaskId, setSelectedWorktreeTaskId, wtRepoConfig, setWtRepoConfig, wtLocalConfig, setWtLocalConfig, savingWtRepo, savingWtLocal, envTextError, setEnvTextError, worktreeTasks, selectedTask, worktreeDirty, discardWorktreeConfig, saveWorktreeConfig } = useProjectSettingsContext();
	useSectionDirty({ dirty: worktreeDirty, saving: savingWtRepo || savingWtLocal, blocked: envTextError, save: saveWorktreeConfig, discard: discardWorktreeConfig });
	return (
			<div className="space-y-7" data-help-id="project-settings.worktree">
				{/* The tab stays visible and explains itself: a tab that vanishes
				    when a setting flips reads as a bug, not as a consequence. */}
				{!repoConfigEnabled(project) ? (
					<WarningNote>{t("projectSettings.worktreeRepoConfigIgnored")}</WarningNote>
				) : worktreeTasks.length === 0 ? (
					<div className="flex flex-col items-center gap-3 py-8 text-center">
						<span className="text-2xl leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF013"}</span>
						<p className="text-fg-muted text-sm max-w-sm">{t("projectSettings.noActiveWorktrees")}</p>
					</div>
				) : (
					<>
						{/* How it works */}
						<div className="px-3 py-2.5 bg-elevated/60 border border-edge/40 rounded-lg">
							<p className="text-fg-3 text-xs leading-relaxed">{t("projectSettings.worktreeHowItWorks")}</p>
						</div>

						{/* Task selector */}
						<div>
							<label htmlFor="worktree-task-selector" className="block text-fg-3 text-xs mb-1">{t("projectSettings.worktreeSelector")}</label>
							<select
								id="worktree-task-selector"
								value={selectedWorktreeTaskId ?? ""}
								onChange={(e) => setSelectedWorktreeTaskId(e.target.value)}
								className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
							>
								{worktreeTasks.map((task) => (
									<option key={task.id} value={task.id}>
										{getTaskTitle(task)}
									</option>
								))}
							</select>
						</div>

						{/* Repo / Local sub-tabs */}
						<div>
							<div role="tablist" aria-label={t("projectSettings.worktreeSubTabsAria")} className="flex gap-1 bg-elevated/50 rounded-xl p-1 mb-1" onKeyDown={handleTabListKeyDown}>
								{([
									{ id: "repo" as WorktreeSubTab, label: t("projectSettings.worktreeRepoTab") },
									{ id: "local" as WorktreeSubTab, label: t("projectSettings.worktreeLocalTab") },
								]).map((tab) => (
									<button
										key={tab.id}
										type="button"
										role="tab"
										aria-selected={worktreeSubTab === tab.id}
										tabIndex={worktreeSubTab === tab.id ? 0 : -1}
										onClick={() => setWorktreeSubTab(tab.id)}
										className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] ${
											worktreeSubTab === tab.id
												? "bg-accent-fill text-white shadow-sm"
												: "text-fg-3 hover:text-fg-2 hover:bg-elevated"
										}`}
									>
										{tab.label}
									</button>
								))}
							</div>
							<p className="text-fg-muted text-xs px-1">
								{worktreeSubTab === "repo"
									? t("projectSettings.worktreeRepoDesc")
									: t("projectSettings.worktreeLocalDesc")}
							</p>
						</div>

						{worktreeSubTab === "repo" ? (
							<ConfigForm
								key={worktreeSubTab}
								config={wtRepoConfig}
								onChange={setWtRepoConfig}
								projectId={projectId}
								projectPath={selectedTask?.worktreePath ?? project.path}
								worktreeLayer={!!selectedTask?.worktreePath && selectedTask.worktreePath !== project.path}
								envStorageScope="repo"
								onEnvErrorChange={setEnvTextError}
							/>
						) : (
							<ConfigForm
								key={worktreeSubTab}
								config={wtLocalConfig}
								onChange={setWtLocalConfig}
								inherited={wtRepoConfig}
								projectId={projectId}
								projectPath={selectedTask?.worktreePath ?? project.path}
								worktreeLayer={!!selectedTask?.worktreePath && selectedTask.worktreePath !== project.path}
								envStorageScope="local"
								onEnvErrorChange={setEnvTextError}
							/>
						)}
					</>
				)}
			</div>
	);
}

function BuiltinAutomationsTab() {
	const { project } = useProjectSettingsContext();
	return (
			<div data-help-id="project-settings.automations">
				<AutomationsPanel project={project} />
			</div>
	);
}

const TAB_BODIES: Record<ProjectSettingsTab, ComponentType<{ ctx: Context }>> = {
	global: BuiltinBoardTab,
	project: BuiltinProjectConfigTab,
	worktree: BuiltinWorktreeTab,
	automations: BuiltinAutomationsTab,
};

/** Every Project Settings tab body, as a required plugin: the tab set itself stays fixed. */
export const BUILTIN_PROJECT_SETTINGS_SECTIONS_PLUGIN: BuiltinPlugin = {
	id: "builtin:project-settings-sections",
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: "builtin:project-settings-sections",
			inject: ["settingsSections"],
			apply(pluginCtx: Context) {
				(Object.keys(TAB_BODIES) as ProjectSettingsTab[]).forEach((tab, order) => {
					pluginCtx.settingsSections.register({
						id: `builtin:project.${tab}`,
						region: `projectSettings.${tab}`,
						order,
						entries: [],
						component: TAB_BODIES[tab],
					});
				});
			},
		});
	},
};
