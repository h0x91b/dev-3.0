import { useEffect, useRef, useState } from "react";
import type { AgentCheckResult, CodingAgent, FavoriteAgentConfig } from "../../shared/types";
import { isFavorite } from "../../shared/favorites";
import { useT } from "../i18n";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { toast } from "../toast";
import AgentAccountIndicator from "./AgentAccountIndicator";
import FavoritesMenu, { StarGlyph } from "./FavoritesMenu";
import Select, { useAgentRenderOption } from "./Select";
import {
	buildPickerGroups,
	getModeLeafLabel,
	groupLabelForConfig,
	groupRequiresPxpipeProxy,
	pickConfigForModelChange,
	resolveFavoriteChips,
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
	/** Show the cross-provider "Favorites" leading column: a compact star trigger
	 *  (fills when the current combo is saved) that opens a popover to save the
	 *  current combo or apply/remove a saved one. Enabled only on the launch
	 *  surfaces (Launch/Retry, Spawn, Bug Hunters); the Settings default-agent
	 *  pickers leave it off. */
	showFavorites?: boolean;
	/** Current favorites (from GlobalSettings). Only read when `showFavorites`. */
	favorites?: FavoriteAgentConfig[];
	/** Toggle a favorite (add or remove) for the given pair. The parent persists
	 *  via the `toggleFavoriteAgent` RPC and syncs its in-memory settings. */
	onToggleFavorite?: (agentId: string, configId: string) => void;
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
	showFavorites = false,
	favorites = [],
	onToggleFavorite,
}: AgentConfigPickerProps) {
	const t = useT();
	const renderAgentOption = useAgentRenderOption(agentAvailability, t("settings.agentNotInstalled"));
	// Favorites popover (anchored to the leading star trigger). Per-picker so the
	// global list is never duplicated across variant rows (decision 125).
	const [favMenuOpen, setFavMenuOpen] = useState(false);
	const favCaretRef = useRef<HTMLButtonElement>(null);
	const favMenuOpenRef = useRef(favMenuOpen);
	favMenuOpenRef.current = favMenuOpen;

	// Escape closes the favorites menu FIRST, without also closing the surrounding
	// modal. useEscapeKey is capture-phase + stopImmediatePropagation, so whichever
	// listener registers first wins; this picker is a child of the launch modal, so
	// its mount-time effect registers before the modal's own Escape handler. The
	// listener is a no-op while the menu is closed (returns without consuming), so
	// Escape then falls through to the modal as normal. (See useEscapeKey docs.)
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key !== "Escape" || !favMenuOpenRef.current) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			setFavMenuOpen(false);
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);

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

	// Favorites quick-pick: ordered/resolved chips for the popover list + whether
	// the current selection is itself starred (drives the trigger star fill).
	const favoriteChips = showFavorites ? resolveFavoriteChips(favorites, agents) : [];
	const currentIsFavorite = !!(agentId && configId && isFavorite(favorites, agentId, configId));

	const cascade = (
		<div className={className}>
			{/* Favorites — a compact leading column (peer to Provider/Model/Mode).
			    The narrow star trigger opens the FavoritesMenu popover; the star
			    fills when the current combo is saved. Always present (even with 0
			    favorites) so "Save this combo" stays reachable. Per-picker, so the
			    global list is never duplicated across variant rows (decision 125). */}
			{showFavorites && (
				<div className="flex flex-col flex-shrink-0">
					<label htmlFor={`${idPrefix}-favorites`} className="text-xs text-fg-3 block mb-1">
						{t("launch.favorites")}
					</label>
					<button
						id={`${idPrefix}-favorites`}
						ref={favCaretRef}
						type="button"
						aria-haspopup="menu"
						aria-expanded={favMenuOpen}
						title={t("launch.favorites")}
						onClick={() => setFavMenuOpen((o) => !o)}
						className={`h-[34px] px-3 flex items-center justify-center gap-2 bg-elevated rounded-lg border transition-colors outline-none ${
							favMenuOpen ? "border-accent" : "border-edge hover:border-edge-active"
						}`}
					>
						<StarGlyph
							filled={currentIsFavorite}
							className={`text-base ${currentIsFavorite ? "text-favorite" : "text-fg-3"}`}
						/>
						<svg
							className={`w-3 h-3 text-fg-3 flex-shrink-0 transition-transform duration-150 ${favMenuOpen ? "rotate-180" : ""}`}
							viewBox="0 0 12 12"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="2,4 6,8 10,4" />
						</svg>
					</button>
				</div>
			)}

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

			{showFavorites && favMenuOpen && favCaretRef.current && (
				<FavoritesMenu
					chips={favoriteChips}
					activeAgentId={agentId}
					activeConfigId={configId}
					currentIsFavorite={currentIsFavorite}
					canSaveCurrent={!!(agentId && configId)}
					onToggleCurrent={() => {
						if (agentId && configId) onToggleFavorite?.(agentId, configId);
					}}
					anchorEl={favCaretRef.current}
					onApply={(a, c) => {
						onChange({ agentId: a, configId: c });
						setFavMenuOpen(false);
					}}
					onRemove={(a, c) => onToggleFavorite?.(a, c)}
					onClose={() => setFavMenuOpen(false)}
				/>
			)}
		</div>
	);

	return cascade;
}

export default AgentConfigPicker;
