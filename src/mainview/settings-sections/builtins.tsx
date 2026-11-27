import type { Context, Fiber } from "cordis";
import type { ComponentType } from "react";
import type { BuiltinPlugin } from "../plugins/runtime";
import AdvancedExperienceSection from "../components/global-settings/AdvancedExperienceSection";
import AgentAccountsSection from "../components/global-settings/AgentAccountsSection";
import AgentEnvDefaultsSection from "../components/global-settings/AgentEnvDefaultsSection";
import AgentRateLimitSettingsSection from "../components/global-settings/AgentRateLimitSettingsSection";
import AgentSettingsSection from "../components/global-settings/AgentSettingsSection";
import AppearanceSettingsSection from "../components/global-settings/AppearanceSettingsSection";
import BehaviorSettingsSection from "../components/global-settings/BehaviorSettingsSection";
import ClaudeModsSection from "../components/global-settings/ClaudeModsSection";
import DeveloperToolsSection from "../components/global-settings/DeveloperToolsSection";
import EpicsSettingsSection from "../components/global-settings/EpicsSettingsSection";
import ExtensionsSettingsSection from "../components/global-settings/ExtensionsSettingsSection";
import KeyboardSettingsSection from "../components/global-settings/KeyboardSettingsSection";
import ModelCatalogSection from "../components/global-settings/ModelCatalogSection";
import NotificationSettingsSection from "../components/global-settings/NotificationSettingsSection";
import PxpipeProxySettingsSection from "../components/global-settings/PxpipeProxySettingsSection";
import SystemSettingsSection from "../components/global-settings/SystemSettingsSection";
import TelemetrySettingsSection from "../components/global-settings/TelemetrySettingsSection";
import TerminalSettingsSection from "../components/global-settings/TerminalSettingsSection";
import WorkspaceSettingsSection from "../components/global-settings/WorkspaceSettingsSection";
import { BUILTIN_SETTINGS_SECTIONS, settingsEntriesOfSection, type BuiltinSettingsSectionId } from "../settings-registry";
import { useSettingsController } from "./controller";
// Defines the `settingsSections` slot on the app root before the built-ins install.
import "./registry";

// Each built-in keeps its bespoke component and its props from the page controller
// (internal state and RPC behind a public placement — recorded tech debt, see the
// `settings-sections-slot` decision record).
function BuiltinAppearanceSection() {
	const s = useSettingsController();
	return (
		<AppearanceSettingsSection
			t={s.t}
			locale={s.locale}
			theme={s.theme}
			zoomLevel={s.zoomLevel}
			onThemeChange={s.applyThemeChange}
			beigeTone={s.beigeTone}
			onBeigeToneChange={s.handleBeigeToneChange}
			onLocaleChange={s.handleLocaleChange}
			onSimplifyModeToggle={s.handleSimplifyModeToggle}
		/>
	);
}

function BuiltinBehaviorSection() {
	const s = useSettingsController();
	return (
		<BehaviorSettingsSection
			t={s.t}
			globalSettings={s.globalSettings}
			tipsResetDone={s.tipsResetDone}
			onDefaultDiffViewModeChange={s.handleDefaultDiffViewModeChange}
			onOpenArtifactsInPopupToggle={s.handleOpenArtifactsInPopupToggle}
			onArtifactTemplateChange={s.handleArtifactTemplateChange}
			onArtifactTemplatePathChange={s.handleArtifactTemplatePathChange}
			onSuggestCompletingTasksAfterMergeToggle={s.handleSuggestCompletingTasksAfterMergeToggle}
			onCompletionOfferStyleChange={s.handleCompletionOfferStyleChange}
			onPrOriginTaskLinkToggle={s.handlePrOriginTaskLinkToggle}
			onAgentLaunchAutoApproveChange={s.handleAgentLaunchAutoApproveChange}
			onConfirmExtraAgentCloseToggle={s.handleConfirmExtraAgentCloseToggle}
			onAutoHibernateChange={s.handleAutoHibernateChange}
			onAutoHibernateConfirmChange={s.handleAutoHibernateConfirmChange}
			prOriginTaskLinkSupported={s.prOriginTaskLinkSupported}
			onTaskSortOrderChange={s.handleTaskSortOrderChange}
			onTaskOpenModeChange={s.handleTaskOpenModeChange}
			onTipsDisabledToggle={s.handleTipsDisabledToggle}
			onTipsReset={s.handleTipsReset}
			onReviewModePromptChange={s.handleReviewModePromptChange}
			onCoordinatorPromptChange={s.handleCoordinatorPromptChange}
		/>
	);
}

function BuiltinEpicsSection() {
	const s = useSettingsController();
	return (
		<EpicsSettingsSection t={s.t} />
	);
}

function BuiltinNotificationsSection() {
	const s = useSettingsController();
	return (
		<NotificationSettingsSection
			t={s.t}
			globalSettings={s.globalSettings}
			onSoundToggle={s.handleSoundToggle}
			onQuestionsSoundToggle={s.handleQuestionsSoundToggle}
			onReviewSoundToggle={s.handleReviewSoundToggle}
			onFocusModeToggle={s.handleFocusModeToggle}
			onWatchByDefaultToggle={s.handleWatchByDefaultToggle}
		/>
	);
}

function BuiltinKeyboardSection() {
	const s = useSettingsController();
	return (
		<KeyboardSettingsSection
			t={s.t}
			digitsFollowSpaces={s.globalSettings.digitsFollowSpaces === true}
			onDigitsFollowSpacesToggle={s.handleDigitsFollowSpacesToggle}
			onShortcutsChange={s.handleShortcutsChange}
		/>
	);
}

function BuiltinTerminalSection() {
	const s = useSettingsController();
	return (
		<TerminalSettingsSection
			t={s.t}
			scrollSpeed={s.scrollSpeed}
			terminalFontFamily={s.terminalFontFamily}
			terminalFontSize={s.terminalFontSize}
			newTaskTerminalBackend={s.newTaskTerminalBackend}
			nativeTerminalAvailability={s.nativeTerminalAvailability}
			terminalPathOpenMode={s.globalSettings.terminalPathOpenMode}
			terminalShell={s.globalSettings.terminalShell}
			shellAvailability={s.shellAvailability}
			dimInactivePanes={s.globalSettings.dimInactivePanes}
			paneTitles={s.globalSettings.paneTitles}
			confirmClosePane={s.globalSettings.confirmClosePane}
			shellPrompt={s.globalSettings.shellPrompt}
			shellPromptCustom={s.globalSettings.shellPromptCustom}
			onShellPromptChange={s.handleShellPromptChange}
			onShellPromptCustomSave={s.handleShellPromptCustomSave}
			onNewTaskTerminalBackendChange={s.handleNewTaskTerminalBackendChange}
			onTerminalPathOpenModeChange={s.handleTerminalPathOpenModeChange}
			onTerminalShellChange={s.handleTerminalShellChange}
			onDimInactivePanesToggle={s.handleDimInactivePanesToggle}
			onPaneTitlesToggle={s.handlePaneTitlesToggle}
			onConfirmClosePaneToggle={s.handleConfirmClosePaneToggle}
		/>
	);
}

function BuiltinAgentsSection() {
	const s = useSettingsController();
	return (
		<AgentSettingsSection
			t={s.t}
			agents={s.agents}
			globalSettings={s.globalSettings}
			onAgentsChange={s.persistAgents}
			onDefaultAgentChange={s.handleDefaultAgentChange}
			onDefaultConfigChange={s.handleDefaultConfigChange}
			onCoordinatorDefaultChange={s.handleCoordinatorDefaultChange}
			onGlobalSettingsChange={s.setGlobalSettings}
			onLeanProtocolToggle={s.handleLeanProtocolToggle}
			focusPreset={s.focusPreset}
			onFocusPresetHandled={s.clearFocusPreset}
		/>
	);
}

function BuiltinAgentRateLimitSection() {
	const s = useSettingsController();
	return (
		<AgentRateLimitSettingsSection
			t={s.t}
			globalSettings={s.globalSettings}
			onToggle={s.handleRateLimitTrackingToggle}
			onShowAccountToggle={s.handleStatusLineShowAccountToggle}
		/>
	);
}

function BuiltinAgentEnvDefaultsSection() {
	const s = useSettingsController();
	return (
		<AgentEnvDefaultsSection
			t={s.t}
			globalSettings={s.globalSettings}
			onChange={s.handleAgentEnvDefaultsChange}
		/>
	);
}

function BuiltinClaudeModsSection() {
	const s = useSettingsController();
	return (
		<ClaudeModsSection t={s.t} />
	);
}

function BuiltinAccountsSection() {
	const s = useSettingsController();
	return (
		<AgentAccountsSection t={s.t} />
	);
}

function BuiltinModelsSection() {
	const s = useSettingsController();
	return (
		<ModelCatalogSection t={s.t} />
	);
}

function BuiltinExtensionsSection() {
	const s = useSettingsController();
	return (
		<ExtensionsSettingsSection t={s.t} />
	);
}

function BuiltinWorkspaceSection() {
	const s = useSettingsController();
	return (
		<WorkspaceSettingsSection
			t={s.t}
			globalSettings={s.globalSettings}
			onAddExternalApp={s.handleAddExternalApp}
			onDeleteExternalApp={s.handleDeleteExternalApp}
			onPickCloneBaseDirectory={s.handlePickCloneBaseDirectory}
			onUpdateExternalApp={s.handleUpdateExternalApp}
		/>
	);
}

function BuiltinSystemSection() {
	const s = useSettingsController();
	return (
		<SystemSettingsSection
			t={s.t}
			globalSettings={s.globalSettings}
			caffeinateAvailable={s.caffeinateAvailable}
			canaryAvailable={s.canaryAvailable}
			onUpdateChannelChange={s.handleUpdateChannelChange}
			onRemoteTunnelChange={s.handleRemoteTunnelChange}
			onRemotePortChange={s.handleRemotePortChange}
			onRemoteSilentUpdateToggle={s.handleRemoteSilentUpdateToggle}
			onRemoteConfirmTabCloseToggle={s.handleRemoteConfirmTabCloseToggle}
			onRemoteAutoFullscreenToggle={s.handleRemoteAutoFullscreenToggle}
			onStaticAccessCodeChange={s.handleStaticAccessCodeChange}
			onPreventSleepToggle={s.handlePreventSleepToggle}
			onResourceLevelsChange={s.handleResourceLevelsChange}
			onConfirmBeforeQuitToggle={s.handleConfirmBeforeQuitToggle}
			onAutoCleanupTaskHistoryToggle={s.handleAutoCleanupTaskHistoryToggle}
			onLogRetentionChange={s.handleLogRetentionChange}
			hostSettingsLoaded={s.hostSettingsLoaded}
		/>
	);
}

function BuiltinTelemetrySection() {
	const s = useSettingsController();
	return (
		<TelemetrySettingsSection
			t={s.t}
			globalSettings={s.globalSettings}
			onToggle={s.handleTelemetryToggle}
		/>
	);
}

function BuiltinPxpipeProxySection() {
	const s = useSettingsController();
	return (
		<PxpipeProxySettingsSection
			t={s.t}
			globalSettings={s.globalSettings}
			onToggle={s.handlePxpipeProxyToggle}
		/>
	);
}

function BuiltinAdvancedExperienceSection() {
	const s = useSettingsController();
	return (
		<AdvancedExperienceSection
			t={s.t}
			globalSettings={s.globalSettings}
			freezeDiagnostics={s.freezeDiagnostics}
			onTerminalBidiToggle={s.handleTerminalBidiToggle}
			onAgentTrafficToggle={s.handleAgentTrafficToggle}
			onFreezeDiagnosticsToggle={s.handleFreezeDiagnosticsToggle}
		/>
	);
}

function BuiltinDeveloperToolsSection() {
	const s = useSettingsController();
	return (
		<DeveloperToolsSection
			t={s.t}
			cliInstallStatus={s.cliInstallStatus}
			cliArmedInstance={s.cliArmedInstance}
			onInstallDev3Cli={s.handleInstallDev3Cli}
		/>
	);
}

const SECTION_COMPONENTS: Record<BuiltinSettingsSectionId, ComponentType<{ ctx: Context }>> = {
	appearance: BuiltinAppearanceSection,
	behavior: BuiltinBehaviorSection,
	epics: BuiltinEpicsSection,
	notifications: BuiltinNotificationsSection,
	keyboard: BuiltinKeyboardSection,
	terminal: BuiltinTerminalSection,
	agents: BuiltinAgentsSection,
	"agent-rate-limit": BuiltinAgentRateLimitSection,
	"agent-env-defaults": BuiltinAgentEnvDefaultsSection,
	"claude-mods": BuiltinClaudeModsSection,
	accounts: BuiltinAccountsSection,
	models: BuiltinModelsSection,
	extensions: BuiltinExtensionsSection,
	workspace: BuiltinWorkspaceSection,
	system: BuiltinSystemSection,
	telemetry: BuiltinTelemetrySection,
	"pxpipe-proxy": BuiltinPxpipeProxySection,
	"advanced-experience": BuiltinAdvancedExperienceSection,
	"developer-tools": BuiltinDeveloperToolsSection,
};

/** Every built-in section, as a required plugin: Settings has no page without them. */
export const BUILTIN_SETTINGS_SECTIONS_PLUGIN: BuiltinPlugin = {
	id: "builtin:settings-sections",
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: "builtin:settings-sections",
			inject: ["settingsSections"],
			apply(pluginCtx: Context) {
				BUILTIN_SETTINGS_SECTIONS.forEach((section, order) => {
					pluginCtx.settingsSections.register({
						id: `builtin:${section.id}`,
						region: section.category,
						order,
						entries: settingsEntriesOfSection(section.id),
						component: SECTION_COMPONENTS[section.id],
					});
				});
			},
		});
	},
};
