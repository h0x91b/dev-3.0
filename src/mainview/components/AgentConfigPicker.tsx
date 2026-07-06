import type { AgentCheckResult, CodingAgent } from "../../shared/types";
import { useT } from "../i18n";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { toast } from "../toast";
import AgentAccountIndicator from "./AgentAccountIndicator";
import Select, { useAgentRenderOption } from "./Select";
import {
	buildPickerGroups,
	getModeLeafLabel,
	groupLabelForConfig,
	groupRequiresPxpipeProxy,
	pickConfigForModelChange,
} from "../utils/agentPicker";

export interface AgentConfigSelection {
	agentId: string | null;
	configId: string | null;
}

interface AgentConfigPickerProps {
	agents: CodingAgent[];
	agentId: string | null;
	configId: string | null;
	/** Fires with the full (agentId, configId) pair on any of the three fields
	 *  changing — the parent always gets a consistent selection to persist. */
	onChange: (next: AgentConfigSelection) => void;
	/** Availability results so the Provider dropdown can flag uninstalled agents. */
	agentAvailability?: AgentCheckResult[];
	/** Unique prefix for the three control ids (label htmlFor targets):
	 *  `${idPrefix}-provider` / `-model` / `-mode`. */
	idPrefix: string;
	/** Layout container className. Defaults to a responsive row (stacks on narrow). */
	className?: string;
	/** Whether the experimental pxpipe token-saving proxy is enabled. When false
	 *  (the default), the gated Model group ("Fable 5 (cost trick)") is shown in
	 *  the Model dropdown but rendered disabled; clicking it nudges the user to
	 *  Settings. Every launch surface passes the live
	 *  `globalSettings.pxpipeProxyEnabled`. */
	pxpipeProxyEnabled?: boolean;
}

/**
 * The Provider → Model → Mode launch picker — shared by every surface that
 * chooses an agent + configuration (Launch/Retry, Spawn Agent, Bug Hunters, and
 * the default-agent settings). Keeping it in one component is deliberate: the
 * flat-`configId` cascade decomposition lives in utils/agentPicker, and this is
 * the single UI that renders it, so new launch surfaces can't quietly drift back
 * to the old two-dropdown (Agent + Configuration) form.
 * See docs/ux/feature-plans/agent-picker-provider-model-mode.md.
 */
function AgentConfigPicker({
	agents,
	agentId,
	configId,
	onChange,
	agentAvailability = [],
	idPrefix,
	className = "flex flex-col sm:flex-row gap-3",
	pxpipeProxyEnabled = false,
}: AgentConfigPickerProps) {
	const t = useT();
	const renderAgentOption = useAgentRenderOption(agentAvailability, t("settings.agentNotInstalled"));

	function handleGatedConfigClick() {
		// The preset is visible but off. Tell the user and offer a one-click jump
		// into the Settings section that enables it (the whole toast is the link).
		toast.info(t("pxpipe.disabledPresetToast"), {
			onClick: () =>
				window.dispatchEvent(
					new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: "proxy" }),
				),
		});
	}

	const selectedAgent = agents.find((a) => a.id === agentId);
	// Provider → Model → Mode cascade: group the flat presets by model (UI-only;
	// the leaf is still a plain configId).
	const groups = buildPickerGroups(selectedAgent);
	const currentGroupLabel = groupLabelForConfig(selectedAgent, configId) ?? groups[0]?.label ?? "";
	const currentGroup = groups.find((g) => g.label === currentGroupLabel) ?? groups[0];
	const modeConfigs = currentGroup?.configs ?? [];

	function handleProviderChange(nextAgentId: string | null) {
		// Reset config to the new provider's default (which also picks its default
		// Model group + Mode via decomposition on render).
		const agent = agents.find((a) => a.id === nextAgentId);
		const nextConfigId = agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null;
		onChange({ agentId: nextAgentId, configId: nextConfigId });
	}

	function handleModelChange(groupLabel: string) {
		// Switching Model keeps the current Mode *kind* when the new group has it
		// (bible §1.0 lazy-human), else falls back to its default.
		const group = buildPickerGroups(selectedAgent).find((g) => g.label === groupLabel);
		if (!group) return;
		const prev = selectedAgent?.configurations.find((c) => c.id === configId) ?? null;
		const next = pickConfigForModelChange(group, prev);
		onChange({ agentId, configId: next?.id ?? group.configs[0]?.id ?? null });
	}

	function handleModeChange(nextConfigId: string) {
		onChange({ agentId, configId: nextConfigId || null });
	}

	return (
		<div className={className}>
			{/* Provider */}
			<div className="flex-1 min-w-0">
				<label htmlFor={`${idPrefix}-provider`} className="text-xs text-fg-3 block mb-1">
					{t("launch.provider")}
				</label>
				<Select
					id={`${idPrefix}-provider`}
					value={agentId ?? ""}
					options={agents.map((a) => ({ value: a.id, label: a.name }))}
					onChange={(val) => handleProviderChange(val || null)}
					renderOption={renderAgentOption}
				/>
				{/* Progressive disclosure: renders only when the selected provider has
				    managed accounts (Settings → Agent Accounts). */}
				<AgentAccountIndicator agent={selectedAgent} />
			</div>

			{/* Model */}
			<div className="flex-1 min-w-0">
				<label htmlFor={`${idPrefix}-model`} className="text-xs text-fg-3 block mb-1">
					{t("launch.model")}
				</label>
				<Select
					id={`${idPrefix}-model`}
					value={currentGroupLabel}
					options={groups.map((g) => ({
						value: g.label,
						label: g.label,
						disabled: groupRequiresPxpipeProxy(g) && !pxpipeProxyEnabled,
					}))}
					onChange={handleModelChange}
					onOptionDisabledClick={handleGatedConfigClick}
				/>
			</div>

			{/* Mode */}
			<div className="flex-1 min-w-0">
				<label htmlFor={`${idPrefix}-mode`} className="text-xs text-fg-3 block mb-1">
					{t("launch.mode")}
				</label>
				<Select
					id={`${idPrefix}-mode`}
					value={configId ?? ""}
					options={modeConfigs.map((c) => ({
						value: c.id,
						label: getModeLeafLabel(c),
					}))}
					onChange={handleModeChange}
				/>
			</div>
		</div>
	);
}

export default AgentConfigPicker;
