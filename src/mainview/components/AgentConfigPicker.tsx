import { useMemo, useRef, useState } from "react";
import type { AgentCheckResult, AgentConfiguration, CodingAgent, FavoriteAgentConfig } from "../../shared/types";
import { isFavorite } from "../../shared/favorites";
import { useT } from "../i18n";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { toast } from "../toast";
import AgentAccountIndicator from "./AgentAccountIndicator";
import FavoritesMenu, { StarGlyph } from "./FavoritesMenu";
import Select, { useAgentRenderOption } from "./Select";
import {
	buildPickerGroups,
	CONNECT_PROVIDER_VALUE,
	getModeLeafLabel,
	groupLabelForConfig,
	groupRequiresPxpipeProxy,
	lockedModelGroups,
	pickConfigForModelChange,
	providerCaptionForConfig,
	resolveFavoriteChips,
	prettifyModel,
} from "../utils/agentPicker";
import { useModelCatalog } from "../hooks/useModelCatalog";
import {
	CLAUDE_ROLE_BUILTIN_MODEL,
	catalogForCurrentRevision,
	pendingPresetUpdates,
	type RecommendedModel,
} from "../../shared/recommended-models";
import { resolveModelRate } from "../../shared/agent-pricing";
import { randomUUID } from "../uuid";
import ConnectProviderModal from "./ConnectProviderModal";
import RecommendedUpdateModal from "./RecommendedUpdateModal";

export interface AgentConfigSelection {
	agentId: string | null;
	configId: string | null;
}

// The fields form a row from 34rem up. A *container* query, not a viewport
// breakpoint: the picker sizes to its dialog column, not to the window. Every
// occurrence is written out in full — Tailwind only scans literal classes.

// Model gets half again the width of its neighbours: its rows carry a caption
// (the provider, or a price and what it replaces) that the other two never have.
const FIELD_COLS_WITH_FAVORITES =
	"[@container_(min-width:34rem)]:grid-cols-[3.75rem_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)]";
const FIELD_COLS = "[@container_(min-width:34rem)]:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)]";

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

/** Round money the way a price list does: a rate under a dollar loses all its
 *  meaning at zero decimals, and one above it gains nothing from two. */
function formatRate(usdPerMillion: number): string {
	return `$${usdPerMillion < 1 ? usdPerMillion.toFixed(2) : usdPerMillion.toFixed(0)}`;
}

/** Caption under an offered model: what it costs and what it stands in for.
 *  Output tokens only — that is the rate that dominates an agent session, and
 *  two numbers in a dropdown row is one too many. */
function lockedCaption(model: RecommendedModel, t: ReturnType<typeof useT>): string | null {
	const rate = resolveModelRate(model.modelId);
	if (!rate) return null;
	return t("launch.lockedCaption", {
		price: formatRate(rate.output),
		// "Claude Opus 5" does not fit a dropdown that is one third of a launch
		// dialog wide, and the vendor is not the point — the slot is.
		builtin: prettifyModel(CLAUDE_ROLE_BUILTIN_MODEL[model.pricedAgainst]).replace(/^Claude /, ""),
	});
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
	 *  `${idPrefix}-harness` / `-model` / `-mode`. */
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
	// Captions the Model options with who serves them, and decides whether the
	// open-source offers still have anything to teach. Null until it loads, and a
	// caption that is not there yet costs nothing.
	const [catalogVersion, setCatalogVersion] = useState(0);
	const catalog = useModelCatalog(catalogVersion);
	const [connectOpen, setConnectOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	// The answer is saved on the spot, but `agents` is a prop: a surface that
	// loaded it once would keep showing a notice the user has already dealt with.
	const [revisionAnswered, setRevisionAnswered] = useState(false);
	// Favorites popover (anchored to the leading star trigger). Per-picker so the
	// global list is never duplicated across variant rows (decision 125).
	// Escape closes the favorites menu before the surrounding modal: the menu is
	// portalled and registers itself in the overlay-layer stack, which dismisses
	// the innermost layer first (utils/overlay-layers.ts).
	const [favMenuOpen, setFavMenuOpen] = useState(false);
	const favCaretRef = useRef<HTMLButtonElement>(null);

	function handleGatedConfigClick(value: string) {
		// Two kinds of locked row land here. An offered model is one click from
		// working, so it opens the flow that makes it work; a pxpipe-gated preset
		// needs a Settings toggle, and the whole toast is the link to it.
		if (lockedByLabel.has(value)) {
			setConnectOpen(true);
			return;
		}
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
	// Keyed by group label, which is what the Model field's option values are.
	const providerCaptions = new Map(
		groups
			.map((group) => [group.label, providerCaptionForConfig(group.configs[0], catalog)] as const)
			.filter(([, caption]) => caption !== null),
	);
	// Models dev3 offers but the user has not connected. They are the only reason
	// a first-time user learns this is possible at all — nobody goes looking for a
	// capability they have never heard of.
	const lockedGroups = lockedModelGroups(selectedAgent, catalog);
	const lockedByLabel = new Map(lockedGroups.map((group) => [group.label, group.locked as RecommendedModel]));
	// Headings only earn their space when there are two kinds of row to tell
	// apart; one heading over an undivided list is decoration.
	const builtinSection = lockedGroups.length > 0 ? t("launch.modelSectionBuiltin") : undefined;
	const openSourceSection = lockedGroups.length > 0 ? t("launch.modelSectionOpenSource") : undefined;
	const currentGroupLabel = groupLabelForConfig(selectedAgent, configId) ?? groups[0]?.label ?? "";
	const currentGroup = groups.find((g) => g.label === currentGroupLabel) ?? groups[0];
	const modeConfigs = currentGroup?.configs ?? [];
	// A preset whose "model" is a set of role bindings is the only one with
	// anything to edit here — everything else pins one model dev3 does not own.
	// The pencil opens THIS record, so it has to be a record: the one selected
	// when that is the role-bound one, else the group's first.
	const roleBound = (config: AgentConfiguration) =>
		!!config.modelRoles && Object.keys(config.modelRoles).length > 0;
	const editablePreset =
		modeConfigs.find((config) => config.id === configId && roleBound(config)) ?? modeConfigs.find(roleBound);
	// dev3's curated set moves with releases. The notice appears only on the
	// preset it would rewrite, and only where that preset is about to be used —
	// a banner on every surface would be an ad for our own opinion.
	const revision = useMemo(() => {
		if (!catalog) return null;
		const next = catalogForCurrentRevision(catalog, randomUUID);
		if (!next) return null;
		const updates = pendingPresetUpdates(agents, next, randomUUID);
		return updates.length > 0 ? { catalog: next, updates } : null;
	}, [agents, catalog]);
	const revisionTouchesSelection = !!(
		editablePreset &&
		!revisionAnswered &&
		revision?.updates.some((update) => update.configId === editablePreset.id)
	);

	function handleProviderChange(nextAgentId: string | null) {
		// Reset config to the new harness's default (which also picks its default
		// Model group + Mode via decomposition on render).
		const agent = agents.find((a) => a.id === nextAgentId);
		const nextConfigId = agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null;
		onChange({ agentId: nextAgentId, configId: nextConfigId });
	}

	function handleModelChange(groupLabel: string) {
		// Not a model: the row that exists so connecting is never more than one
		// click away, whether or not anything is being advertised above it.
		if (groupLabel === CONNECT_PROVIDER_VALUE) {
			setConnectOpen(true);
			return;
		}
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
					<label htmlFor={`${idPrefix}-harness`} className={labelClass}>
						{t("launch.harness")}
					</label>
					<Select
						id={`${idPrefix}-harness`}
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
					{/* The pencil sits beside the field, not inside the list: it edits the
					    preset that is currently selected, and a row in the list is not
					    selected until it is clicked. Only for a preset whose "model" is a
					    set of role bindings — there is nothing else to change. */}
					<div className="flex items-center gap-1.5 min-w-0">
					<Select
						id={`${idPrefix}-model`}
						value={currentGroupLabel}
						options={[
							...groups.map((g) => ({
								value: g.label,
								label: g.label,
								disabled: groupRequiresPxpipeProxy(g) && !pxpipeProxyEnabled,
								section: builtinSection,
							})),
							...lockedGroups.map((g) => ({
								value: g.label,
								label: g.label,
								disabled: true,
								section: openSourceSection,
							})),
							// `custom` so it renders as its own plain row: it is an action,
							// and captioning it with a provider or a price would be a lie.
							{ value: CONNECT_PROVIDER_VALUE, label: t("launch.connectProvider"), custom: true, section: openSourceSection },
						]}
						onChange={handleModelChange}
						onOptionDisabledClick={handleGatedConfigClick}
						growList
						renderOption={(option) => {
							const offered = lockedByLabel.get(option.value);
							const caption = offered ? lockedCaption(offered, t) : providerCaptions.get(option.value);
							return (
								<span className="flex items-baseline gap-1.5 min-w-0">
									<span className="truncate">{option.label}</span>
									{caption ? <span className="text-fg-3 text-micro shrink-0">{caption}</span> : null}
								</span>
							);
						}}
					/>
					{editablePreset && selectedAgent && (
						<button
							type="button"
							data-testid={`${idPrefix}-edit-models`}
							title={t("launch.editModels")}
							aria-label={t("launch.editModels")}
							onClick={() =>
								// `section` is a CATEGORY, not the `agents-editor` entry id: the
								// event resolves anything else to the first category, silently,
								// so a wrong value here lands the user on Appearance. `preset`
								// is what turns "the Agents page" into "this preset, selected".
								window.dispatchEvent(
									new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, {
										detail: {
											section: "agents",
											preset: { agentId: selectedAgent.id, configId: editablePreset.id },
										},
									}),
								)
							}
							className="h-[34px] w-[34px] flex items-center justify-center shrink-0 bg-elevated rounded-lg border border-edge text-fg-3 hover:text-fg hover:border-edge-active transition-colors outline-none"
						>
							<svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 20h9" />
								<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
							</svg>
						</button>
					)}
					</div>
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
				    disclosure — the indicator renders only when the harness has managed
				    accounts, and `empty:hidden` then drops this line entirely. */}
				<div className="col-span-full min-w-0 empty:hidden">
					<AgentAccountIndicator agent={selectedAgent} value={accountId} onSelect={onAccountChange} />
				</div>

				{/* Its own full-width line under the fields: it is about the selection as
				    a whole, and it must not squeeze the Model field it sits below. */}
				{revisionTouchesSelection && (
					<button
						type="button"
						data-testid={`${idPrefix}-recommended-update`}
						onClick={() => setUpdateOpen(true)}
						className="col-span-full min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-warning/5 border border-warning/20 text-left hover:border-warning/40 transition-colors"
					>
						<span className="text-warning-strong text-xs shrink-0">&#9888;</span>
						<span className="text-fg-2 text-xs truncate">{t("recommendedUpdate.notice")}</span>
						<span className="text-accent text-xs font-medium shrink-0 ml-auto">
							{t("recommendedUpdate.review")}
						</span>
					</button>
				)}
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

			{/* Connecting seeds the catalog and the presets, and the agent list
			    refreshes itself off the `agentsUpdated` push; only the catalog has no
			    push of its own, so the picker re-reads it here. */}
			{connectOpen && (
				<ConnectProviderModal
					onClose={() => setConnectOpen(false)}
					onConnected={() => setCatalogVersion((v) => v + 1)}
				/>
			)}

			{updateOpen && revision && (
				<RecommendedUpdateModal
					updates={revision.updates}
					agentCommands={Object.fromEntries(agents.map((agent) => [agent.id, agent.baseCommand]))}
					onClose={() => setUpdateOpen(false)}
					onApplied={() => {
						setRevisionAnswered(true);
						setCatalogVersion((v) => v + 1);
					}}
				/>
			)}
		</div>
	);
}

export default AgentConfigPicker;
