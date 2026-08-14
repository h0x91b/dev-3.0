import { useState } from "react";
import type { GlobalSettings } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import SettingsSection from "./SettingsSection";
import SettingsEntry from "./SettingsEntry";
import SettingsToggle from "./SettingsToggle";

const AUTO_OPEN_IMAGES_KEY = "dev3-auto-open-shared-images";

interface BehaviorSettingsSectionProps {
	t: TFunction;
	globalSettings: GlobalSettings;
	tipsResetDone: boolean;
	onDefaultDiffViewModeChange: (mode: "split" | "unified" | "auto") => void;
	onSoundToggle: (enabled: boolean) => void;
	onWatchByDefaultToggle: (enabled: boolean) => void;
	onSuggestCompletingTasksAfterMergeToggle: (enabled: boolean) => void;
	onPrOriginTaskLinkToggle: (enabled: boolean) => void;
	/** False on a host with no OS-registered `dev3://` handler (Windows, Linux) — the
	 *  toggle then reads Off and inert, while the stored preference on disk is untouched. */
	prOriginTaskLinkSupported: boolean;
	onFocusModeToggle: (enabled: boolean) => void;
	onTaskSortOrderChange: (order: GlobalSettings["taskSortOrder"]) => void;
	onTaskOpenModeChange: (mode: "split" | "fullscreen") => void;
	onTipsDisabledToggle: (disabled: boolean) => void;
	onTipsReset: () => void;
	/** Blank string = follow the localized built-in prompt. */
	onReviewModePromptChange: (prompt: string) => void;
}

export default function BehaviorSettingsSection({
	t,
	globalSettings,
	tipsResetDone,
	onDefaultDiffViewModeChange,
	onSoundToggle,
	onWatchByDefaultToggle,
	onSuggestCompletingTasksAfterMergeToggle,
	onPrOriginTaskLinkToggle,
	prOriginTaskLinkSupported,
	onFocusModeToggle,
	onTaskSortOrderChange,
	onTaskOpenModeChange,
	onTipsDisabledToggle,
	onTipsReset,
	onReviewModePromptChange,
}: BehaviorSettingsSectionProps) {
	const builtinReviewPrompt = t("createTask.reviewPrompt");
	// Edited locally and persisted on blur — a save per keystroke would rewrite
	// settings.json on every character.
	const [reviewPrompt, setReviewPrompt] = useState(
		globalSettings.reviewModePrompt ?? builtinReviewPrompt,
	);
	const reviewPromptIsCustom = reviewPrompt.trim() !== builtinReviewPrompt.trim();
	const commitReviewPrompt = (value: string) => {
		// Storing the built-in text verbatim would freeze the prompt to today's
		// locale, so an untouched field stays "not set".
		onReviewModePromptChange(value.trim() === builtinReviewPrompt.trim() ? "" : value);
	};
	// Auto-open the shared-image viewer when an agent pushes an image while you're
	// already looking at the task. Local UI preference (like theme/task-open-mode).
	const [autoOpenImages, setAutoOpenImages] = useState(() => {
		try {
			return localStorage.getItem(AUTO_OPEN_IMAGES_KEY) !== "off";
		} catch {
			return true;
		}
	});
	const toggleAutoOpenImages = () => {
		const next = !autoOpenImages;
		setAutoOpenImages(next);
		try {
			localStorage.setItem(AUTO_OPEN_IMAGES_KEY, next ? "on" : "off");
		} catch {
			/* storage blocked — in-memory value still applies this session */
		}
	};
	return (
		<SettingsSection title={t("settings.categoryTasks")} helpTopicId="settings.tasks">
			<SettingsEntry anchor="task-sort-order">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskSortOrder")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.taskSortOrderDesc")}
				</p>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<SortOrderCard
						label={t("settings.taskSortOldest")}
						description={t("settings.taskSortOldestDesc")}
						active={globalSettings.taskSortOrder !== "newest-first"}
						onClick={() => onTaskSortOrderChange("oldest-first")}
						icon="↑"
					/>
					<SortOrderCard
						label={t("settings.taskSortNewest")}
						description={t("settings.taskSortNewestDesc")}
						active={globalSettings.taskSortOrder === "newest-first"}
						onClick={() => onTaskSortOrderChange("newest-first")}
						icon="↓"
					/>
				</div>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="task-complete-sound">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskCompleteSound")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.taskCompleteSoundDesc")}
				</p>
				<SettingsToggle
					checked={globalSettings.playSoundOnTaskComplete !== false}
					ariaLabel={t("settings.taskCompleteSound")}
					onLabel={t("settings.on")}
					offLabel={t("settings.off")}
					onToggle={() =>
						onSoundToggle(globalSettings.playSoundOnTaskComplete === false)
					}
				/>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="focus-mode">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.focusMode")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.focusModeDesc")}
				</p>
				<SettingsToggle
					checked={globalSettings.focusMode === true}
					ariaLabel={t("settings.focusMode")}
					onLabel={t("settings.on")}
					offLabel={t("settings.off")}
					onToggle={() => onFocusModeToggle(globalSettings.focusMode !== true)}
				/>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="watch-by-default">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.watchByDefault")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.watchByDefaultDesc")}
				</p>
				<SettingsToggle
					checked={globalSettings.watchByDefault === true}
					ariaLabel={t("settings.watchByDefault")}
					onLabel={t("settings.on")}
					offLabel={t("settings.off")}
					onToggle={() =>
						onWatchByDefaultToggle(globalSettings.watchByDefault !== true)
					}
				/>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="suggest-completing-after-merge">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.suggestCompletingTasksAfterMerge")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.suggestCompletingTasksAfterMergeDesc")}
				</p>
				<SettingsToggle
					checked={globalSettings.suggestCompletingTasksAfterMerge !== false}
					ariaLabel={t("settings.suggestCompletingTasksAfterMerge")}
					onLabel={t("settings.on")}
					offLabel={t("settings.off")}
					onToggle={() =>
						onSuggestCompletingTasksAfterMergeToggle(globalSettings.suggestCompletingTasksAfterMerge === false)
					}
				/>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="pr-origin-task-link">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.prOriginTaskLink")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.prOriginTaskLinkDesc")}
				</p>
				{prOriginTaskLinkSupported ? null : (
					<p
						className="text-warning text-xs mb-3 break-words"
						data-testid="pr-origin-task-link-unsupported"
					>
						{t("settings.prOriginTaskLinkUnsupported")}
					</p>
				)}
				<SettingsToggle
					checked={prOriginTaskLinkSupported && globalSettings.prOriginTaskLink !== false}
					disabled={!prOriginTaskLinkSupported}
					ariaLabel={t("settings.prOriginTaskLink")}
					onLabel={t("settings.on")}
					offLabel={t("settings.off")}
					onToggle={() =>
						onPrOriginTaskLinkToggle(globalSettings.prOriginTaskLink === false)
					}
				/>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="auto-open-images">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.autoOpenImages")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.autoOpenImagesDesc")}
				</p>
				<SettingsToggle
					checked={autoOpenImages}
					ariaLabel={t("settings.autoOpenImages")}
					onLabel={t("settings.on")}
					offLabel={t("settings.off")}
					onToggle={toggleAutoOpenImages}
				/>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="task-open-mode">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskOpenMode")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.taskOpenModeDesc")}
				</p>
				<div className="flex flex-col gap-3 sm:flex-row">
					{(["split", "fullscreen"] as const).map((mode) => (
						<button
							key={mode}
							onClick={() => onTaskOpenModeChange(mode)}
							className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm transition-colors ${
								(globalSettings.taskOpenMode ?? "split") === mode
									? "border-accent bg-accent/10 text-accent"
									: "border-edge bg-raised text-fg hover:border-edge-active"
							}`}
						>
							{mode === "split"
								? t("settings.taskOpenModeSplit")
								: t("settings.taskOpenModeFullscreen")}
						</button>
					))}
				</div>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="default-diff-view">
			<div>
				<p className="block text-fg text-sm font-semibold mb-2">
					{t("settings.defaultDiffViewMode")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.defaultDiffViewModeDesc")}
				</p>
				<div className="flex flex-col gap-3 sm:flex-row">
					{(["auto", "split", "unified"] as const).map((mode) => (
						<button
							key={mode}
							onClick={() => onDefaultDiffViewModeChange(mode)}
							className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm transition-colors ${
								(globalSettings.defaultDiffViewMode ?? "auto") === mode
									? "border-accent bg-accent/10 text-accent"
									: "border-edge bg-raised text-fg hover:border-edge-active"
							}`}
						>
							{mode === "split"
								? t("settings.defaultDiffViewModeSplit")
								: mode === "unified"
									? t("settings.defaultDiffViewModeUnified")
									: t("settings.defaultDiffViewModeAuto")}
						</button>
					))}
				</div>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="review-mode-prompt">
			<div>
				<label htmlFor="review-mode-prompt" className="block text-fg text-sm font-semibold mb-2">
					{t("settings.reviewModePrompt")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.reviewModePromptDesc")}
				</p>
				<textarea
					id="review-mode-prompt"
					value={reviewPrompt}
					onChange={(e) => setReviewPrompt(e.target.value)}
					onBlur={(e) => commitReviewPrompt(e.target.value)}
					rows={8}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
				<div className="mt-3 flex items-center gap-3">
					<button
						type="button"
						disabled={!reviewPromptIsCustom}
						onClick={() => {
							setReviewPrompt(builtinReviewPrompt);
							onReviewModePromptChange("");
						}}
						className="text-sm text-fg-3 hover:text-accent transition-colors px-3 py-1.5 rounded-lg border border-edge hover:border-accent/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-fg-3 disabled:hover:border-edge"
					>
						{t("settings.reviewModePromptReset")}
					</button>
					{reviewPromptIsCustom && (
						<span className="text-fg-muted text-xs">{t("settings.reviewModePromptCustom")}</span>
					)}
				</div>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="tips">
			<div>
				<p className="block text-fg text-sm font-semibold mb-3">
					{t("settings.tipsSection")}
				</p>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.tipsDesc")}
				</p>
				<div className="flex flex-wrap items-center gap-4">
					<label className="inline-flex items-center gap-3 cursor-pointer select-none">
						<div
							role="switch"
							aria-checked={globalSettings.tipsDisabled !== true}
							aria-label={t("settings.tipsDisabled")}
							tabIndex={0}
							className={`relative w-11 h-6 rounded-full transition-colors ${
								globalSettings.tipsDisabled
									? "bg-accent"
									: "bg-raised border border-edge"
							}`}
							onClick={() =>
								onTipsDisabledToggle(!globalSettings.tipsDisabled)
							}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onTipsDisabledToggle(!globalSettings.tipsDisabled);
								}
							}}
						>
							<div
								className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
									globalSettings.tipsDisabled ? "" : "translate-x-5"
								}`}
							/>
						</div>
						<span className="text-fg text-sm">
							{t("settings.tipsDisabled")}
						</span>
					</label>
					<button
						onClick={onTipsReset}
						className="text-sm text-fg-3 hover:text-accent transition-colors px-3 py-1.5 rounded-lg border border-edge hover:border-accent/30"
					>
						{tipsResetDone
							? t("settings.tipsResetDone")
							: t("settings.tipsReset")}
					</button>
				</div>
			</div>
			</SettingsEntry>
		</SettingsSection>
	);
}

function SortOrderCard({
	label,
	description,
	active,
	onClick,
	icon,
}: {
	label: string;
	description: string;
	active: boolean;
	onClick: () => void;
	icon: string;
}) {
	return (
		<button
			onClick={onClick}
			className={`flex-1 p-4 rounded-xl border-2 transition-[border-color,box-shadow] text-left ${
				active
					? "border-accent shadow-lg shadow-accent/10"
					: "border-edge hover:border-edge-active"
			}`}
		>
			<div className="text-2xl mb-2 font-mono text-fg-2 font-bold">{icon}</div>
			<div className="text-fg text-sm font-semibold">{label}</div>
			<div className="text-fg-3 text-xs mt-0.5">{description}</div>
		</button>
	);
}
