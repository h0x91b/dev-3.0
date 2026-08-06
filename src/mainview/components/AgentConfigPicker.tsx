import { useRef, useState } from "react";
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

// The fields form a row from 34rem up. A *container* query, not a viewport
// breakpoint: the picker sizes to its dialog column, not to the window. Every
// occurrence is written out in full — Tailwind only scans literal classes.

const FIELD_COLS_WITH_FAVORITES =
	"[@container_(min-width:34rem)]:grid-cols-[3.75rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";
const FIELD_COLS = "[@container_(min-width:34rem)]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

/** The picker's own field rails. */
export function pickerFieldsGridClass(withFavorites: boolean): string {
	return `grid gap-3 grid-cols-1 ${withFavorites ? FIELD_COLS_WITH_FAVORITES : FIELD_COLS}`;
}

/** Rails for a labels header a parent renders once above a list of pickers
 *  (`showLabels={false}`). Hidden while the fields stack — each picker shows its
 *  own labels there. */
export function pickerLabelsHeaderClass(withFavorites: boolean): string {
	return `hidden gap-3 [@container_(min-width:34rem)]:grid ${withFavorites ? FIELD_COLS_WITH_FAVORITES : FIELD_COLS}`;
}

/** Wrap that header so its container query matches the picker's: the header cell
 *  and the picker are the same width. */
export const PICKER_HEADER_CONTAINER_CLASS = "[container-type:inline-size]";

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
	/** Classes for the picker's outer box (sizing inside the parent's own row).
	 *  The field rails themselves are owned by the picker. */
	className?: string;
	/** Render the per-field labels ("Favorites / Provider / Model / Mode").
	 *  Pass `false` when the parent shows them once above a list of pickers
	 *  (LaunchVariantsModal) — the labels then stay in the DOM as the controls'
	 *  accessible names and reappear when the fields stack, where no header
	 *  is shown. */
	showLabels?: boolean;
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
	/** Per-launch managed account selection for the account pill under Provider:
	 *  `undefined` → the registry default; `null` → system login; string → account.
	 *  Only meaningful together with `onAccountChange` (spawn surfaces). */
	accountId?: string | null;
	/** When provided, the account pill becomes a LOCAL per-launch selector writing
	 *  here (spawn dialogs). When omitted the pill stays the global default
	 *  switcher (Settings surfaces). */
	onAccountChange?: (accountId: string | null) => void;
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
	className = "",
	showLabels = true,
	pxpipeProxyEnabled = false,
	showFavorites = false,
	favorites = [],
	onToggleFavorite,
	accountId,
	onAccountChange,
}: AgentConfigPickerProps) {
	const t = useT();
	const renderAgentOption = useAgentRenderOption(agentAvailability, t("settings.agentNotInstalled"));
	// Favorites popover (anchored to the leading star trigger). Per-picker so the
	// global list is never duplicated across variant rows (decision 125).
	// Escape closes the favorites menu before the surrounding modal: the menu is
	// portalled and registers itself in the overlay-layer stack, which dismisses
	// the innermost layer first (utils/overlay-layers.ts).
	const [favMenuOpen, setFavMenuOpen] = useState(false);
	const favCaretRef = useRef<HTMLButtonElement>(null);

	function handleGatedConfigClick() {
		// The preset is visible but off. Tell the user and offer a one-click jump
		// into the Settings section that enables it (the whole toast is the link).
		toast.info(t("pxpipe.disabledPresetToast"), {
			source: "settings",
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

	// Labels stay in the DOM even when the parent renders them once above a list
	// of pickers: they are the controls' accessible names (Select renders a
	// <button>, which `htmlFor` labels), and they become visible again where the
	// fields stack and no header is shown.
	const labelClass = showLabels
		? "text-xs text-fg-3 block mb-1"
		: "text-xs text-fg-3 block mb-1 [@container_(min-width:34rem)]:sr-only";

	return (
		<div className={`[container-type:inline-size] ${className}`}>
			<div className={pickerFieldsGridClass(showFavorites)}>
				{/* Favorites — a compact leading column (peer to Provider/Model/Mode).
				    The narrow star trigger opens the FavoritesMenu popover; the star
				    fills when the current combo is saved. Always present (even with 0
				    favorites) so "Save this combo" stays reachable. Per-picker, so the
				    global list is never duplicated across variant rows (decision 125). */}
				{showFavorites && (
					<div className="min-w-0">
						<label htmlFor={`${idPrefix}-favorites`} className={labelClass}>
							{t("launch.favorites")}
						</label>
						{/* w-fit: the cell is full width while the fields stack, the
						    trigger must not stretch into a giant empty box. */}
						<button
							id={`${idPrefix}-favorites`}
							ref={favCaretRef}
							type="button"
							aria-haspopup="menu"
							aria-expanded={favMenuOpen}
							title={t("launch.favorites")}
							onClick={() => setFavMenuOpen((o) => !o)}
							className={`h-[34px] w-fit px-3 flex items-center justify-center gap-2 bg-elevated rounded-lg border transition-colors outline-none ${
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
				<div className="min-w-0">
					<label htmlFor={`${idPrefix}-provider`} className={labelClass}>
						{t("launch.provider")}
					</label>
					<Select
						id={`${idPrefix}-provider`}
						value={agentId ?? ""}
						options={agents.map((a) => ({ value: a.id, label: a.name }))}
						onChange={(val) => handleProviderChange(val || null)}
						renderOption={renderAgentOption}
					/>
				</div>

				{/* Model */}
				<div className="min-w-0">
					<label htmlFor={`${idPrefix}-model`} className={labelClass}>
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
				<div className="min-w-0">
					<label htmlFor={`${idPrefix}-mode`} className={labelClass}>
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

				{/* The account belongs to the whole selection, not to Provider: its own
				    full-width line keeps the field columns the same height. Progressive
				    disclosure — the indicator renders only when the provider has managed
				    accounts, and `empty:hidden` then drops this line entirely. */}
				<div className="col-span-full min-w-0 empty:hidden">
					<AgentAccountIndicator agent={selectedAgent} value={accountId} onSelect={onAccountChange} />
				</div>
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
					triggerRef={favCaretRef}
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
}

export default AgentConfigPicker;
