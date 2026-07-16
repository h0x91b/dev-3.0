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
	onFocusModeToggle: (enabled: boolean) => void;
	onTaskDropPositionChange: (position: "top" | "bottom") => void;
	onTaskOpenModeChange: (mode: "split" | "fullscreen") => void;
	onTipsDisabledToggle: (disabled: boolean) => void;
	onTipsReset: () => void;
}

export default function BehaviorSettingsSection({
	t,
	globalSettings,
	tipsResetDone,
	onDefaultDiffViewModeChange,
	onSoundToggle,
	onWatchByDefaultToggle,
	onFocusModeToggle,
	onTaskDropPositionChange,
	onTaskOpenModeChange,
	onTipsDisabledToggle,
	onTipsReset,
}: BehaviorSettingsSectionProps) {
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
			<SettingsEntry anchor="task-drop-position">
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskDropPosition")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.taskDropPositionDesc")}
				</p>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<DropPositionCard
						label={t("settings.dropToTop")}
						description={t("settings.dropToTopDesc")}
						active={globalSettings.taskDropPosition === "top"}
						onClick={() => onTaskDropPositionChange("top")}
						icon="↑"
					/>
					<DropPositionCard
						label={t("settings.dropToBottom")}
						description={t("settings.dropToBottomDesc")}
						active={globalSettings.taskDropPosition === "bottom"}
						onClick={() => onTaskDropPositionChange("bottom")}
						icon="↓"
					/>
				</div>
			</div>
			</SettingsEntry>

			<SettingsEntry anchor="task-complete-sound">
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskCompleteSound")}
				</label>
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
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.focusMode")}
				</label>
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
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.watchByDefault")}
				</label>
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

			<SettingsEntry anchor="auto-open-images">
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.autoOpenImages")}
				</label>
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
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskOpenMode")}
				</label>
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
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.defaultDiffViewMode")}
				</label>
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

			<SettingsEntry anchor="tips">
			<div>
				<label className="block text-fg text-sm font-semibold mb-3">
					{t("settings.tipsSection")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.tipsDesc")}
				</p>
				<div className="flex flex-wrap items-center gap-4">
					<label className="inline-flex items-center gap-3 cursor-pointer select-none">
						<div
							role="switch"
							aria-checked={globalSettings.tipsDisabled === true}
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
									globalSettings.tipsDisabled ? "translate-x-5" : ""
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

function DropPositionCard({
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
			className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
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
