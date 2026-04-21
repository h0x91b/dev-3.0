import type {
	GlobalSettings,
	Project,
	TasksQuickSwitchFilter,
	TasksQuickSwitchShortcut,
	TerminalKeymapPreset,
} from "../../../shared/types";
import type { TFunction } from "../../i18n";
import SettingsSection from "./SettingsSection";
import TasksQuickSwitchSettings from "./TasksQuickSwitchSettings";

interface BehaviorSettingsSectionProps {
	t: TFunction;
	globalSettings: GlobalSettings;
	projects: Project[];
	caffeinateAvailable: boolean;
	keymapPreset: TerminalKeymapPreset;
	tipsResetDone: boolean;
	onDefaultDiffViewModeChange: (mode: "split" | "unified") => void;
	onKeymapChange: (preset: TerminalKeymapPreset) => void;
	onPreventSleepToggle: (enabled: boolean) => void;
	onSoundToggle: (enabled: boolean) => void;
	onTasksQuickSwitchShortcutChange: (
		shortcut: TasksQuickSwitchShortcut,
	) => void;
	onTasksQuickSwitchFiltersChange: (filters: TasksQuickSwitchFilter[]) => void;
	onTaskDropPositionChange: (position: "top" | "bottom") => void;
	onTaskOpenModeChange: (mode: "split" | "fullscreen") => void;
	onTipsDisabledToggle: (disabled: boolean) => void;
	onTipsReset: () => void;
}

export default function BehaviorSettingsSection({
	t,
	globalSettings,
	projects,
	caffeinateAvailable,
	keymapPreset,
	tipsResetDone,
	onDefaultDiffViewModeChange,
	onKeymapChange,
	onPreventSleepToggle,
	onSoundToggle,
	onTasksQuickSwitchShortcutChange,
	onTasksQuickSwitchFiltersChange,
	onTaskDropPositionChange,
	onTaskOpenModeChange,
	onTipsDisabledToggle,
	onTipsReset,
}: BehaviorSettingsSectionProps) {
	return (
		<SettingsSection title={t("settings.behaviorSection")}>
			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskDropPosition")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.taskDropPositionDesc")}
				</p>
				<div className="flex gap-3">
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

			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.terminalKeymap")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.terminalKeymapDesc")}
				</p>
				<button
					onClick={() =>
						onKeymapChange(keymapPreset === "iterm2" ? "default" : "iterm2")
					}
					className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 transition-all text-left ${
						keymapPreset === "iterm2"
							? "border-accent shadow-lg shadow-accent/10"
							: "border-edge hover:border-edge-active"
					}`}
				>
					<div
						className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
							keymapPreset === "iterm2"
								? "border-accent bg-accent"
								: "border-edge-active"
						}`}
					>
						{keymapPreset === "iterm2" ? (
							<svg width="10" height="8" viewBox="0 0 10 8" fill="none">
								<path
									d="M1 4L3.5 6.5L9 1"
									stroke="white"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						) : null}
					</div>
					<div>
						<div className="text-fg text-sm font-semibold">
							{t("settings.keymapIterm2")}
						</div>
						<div className="text-fg-3 text-xs mt-0.5">
							{t("settings.keymapIterm2Desc")}
						</div>
					</div>
				</button>
			</div>

			<TasksQuickSwitchSettings
				t={t}
				globalSettings={globalSettings}
				projects={projects}
				onTasksQuickSwitchShortcutChange={onTasksQuickSwitchShortcutChange}
				onTasksQuickSwitchFiltersChange={onTasksQuickSwitchFiltersChange}
			/>

			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskCompleteSound")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.taskCompleteSoundDesc")}
				</p>
				<ToggleSwitch
					checked={globalSettings.playSoundOnTaskComplete !== false}
					onToggle={() =>
						onSoundToggle(globalSettings.playSoundOnTaskComplete === false)
					}
				/>
			</div>

			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.preventSleep")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.preventSleepDesc")}
				</p>
				<ToggleSwitch
					checked={
						globalSettings.preventSleepWhileRunning !== false &&
						caffeinateAvailable
					}
					disabled={!caffeinateAvailable}
					onToggle={() =>
						onPreventSleepToggle(
							globalSettings.preventSleepWhileRunning === false,
						)
					}
				/>
				{!caffeinateAvailable ? (
					<p className="text-fg-muted text-xs mt-2">
						{t("settings.preventSleepNotAvailable")}
					</p>
				) : null}
			</div>

			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.taskOpenMode")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.taskOpenModeDesc")}
				</p>
				<div className="flex gap-3">
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

			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.defaultDiffViewMode")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.defaultDiffViewModeDesc")}
				</p>
				<div className="flex gap-3">
					{(["split", "unified"] as const).map((mode) => (
						<button
							key={mode}
							onClick={() => onDefaultDiffViewModeChange(mode)}
							className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm transition-colors ${
								(globalSettings.defaultDiffViewMode ?? "split") === mode
									? "border-accent bg-accent/10 text-accent"
									: "border-edge bg-raised text-fg hover:border-edge-active"
							}`}
						>
							{mode === "split"
								? t("settings.defaultDiffViewModeSplit")
								: t("settings.defaultDiffViewModeUnified")}
						</button>
					))}
				</div>
			</div>

			<div>
				<label className="block text-fg text-sm font-semibold mb-3">
					{t("settings.tipsSection")}
				</label>
				<div className="flex items-center gap-4">
					<label className="inline-flex items-center gap-3 cursor-pointer select-none">
						<div
							role="switch"
							aria-checked={globalSettings.tipsDisabled === true}
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
		</SettingsSection>
	);
}

function ToggleSwitch({
	checked,
	disabled = false,
	onToggle,
}: {
	checked: boolean;
	disabled?: boolean;
	onToggle: () => void;
}) {
	return (
		<label className="inline-flex items-center gap-3 cursor-pointer select-none">
			<div
				role="switch"
				aria-checked={checked}
				tabIndex={0}
				className={`relative w-11 h-6 rounded-full transition-colors ${
					disabled
						? "bg-raised border border-edge opacity-50 cursor-not-allowed"
						: checked
							? "bg-accent"
							: "bg-raised border border-edge"
				}`}
				onClick={() => {
					if (!disabled) onToggle();
				}}
				onKeyDown={(event) => {
					if (!disabled && (event.key === "Enter" || event.key === " ")) {
						event.preventDefault();
						onToggle();
					}
				}}
			>
				<div
					className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
						checked ? "translate-x-5" : ""
					}`}
				/>
			</div>
			<span className="text-fg text-sm">{checked ? "On" : "Off"}</span>
		</label>
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
