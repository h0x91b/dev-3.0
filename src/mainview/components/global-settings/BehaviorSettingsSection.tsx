import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type Ref,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
	GlobalSettings,
	Project,
	TasksQuickSwitchFilter,
	TasksQuickSwitchShortcut,
	TerminalKeymapPreset,
} from "../../../shared/types";
import {
	makeTasksQuickSwitchCustomFilter,
	normalizeTasksQuickSwitchFilters,
	normalizeTasksQuickSwitchShortcut,
	TASKS_QUICK_SWITCH_FILTER_STATUSES,
} from "../../../shared/types";
import { statusKey, type TFunction } from "../../i18n";
import { useStatusColors } from "../../hooks/useStatusColors";
import {
	ALT_TAB_QUICK_SWITCH_SHORTCUT,
	CTRL_TAB_QUICK_SWITCH_SHORTCUT,
	formatTasksQuickSwitchShortcut,
	getTasksQuickSwitchShortcutFromKeyboardEvent,
	isPresetTasksQuickSwitchShortcut,
	TASKS_QUICK_SWITCH_SHORTCUT_MODAL_ATTR,
	TASKS_QUICK_SWITCH_SHORTCUT_RECORDER_ATTR,
} from "../../tasks-quick-switch-shortcut";
import SettingsSection from "./SettingsSection";

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

interface QuickSwitchTaskTypeOption {
	id: TasksQuickSwitchFilter;
	label: string;
	color: string;
}

function toggleQuickSwitchFilter(
	currentFilters: TasksQuickSwitchFilter[],
	filter: TasksQuickSwitchFilter,
): TasksQuickSwitchFilter[] {
	const selected = new Set(currentFilters);
	if (selected.has(filter)) {
		selected.delete(filter);
	} else {
		selected.add(filter);
	}
	return normalizeTasksQuickSwitchFilters(Array.from(selected));
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
	const statusColors = useStatusColors();
	const [isQuickSwitchShortcutModalOpen, setIsQuickSwitchShortcutModalOpen] =
		useState(false);
	const [isRecordingQuickSwitchShortcut, setIsRecordingQuickSwitchShortcut] =
		useState(false);
	const [quickSwitchShortcutDraft, setQuickSwitchShortcutDraft] =
		useState<TasksQuickSwitchShortcut | null>(null);
	const [quickSwitchShortcutError, setQuickSwitchShortcutError] = useState<
		string | null
	>(null);
	const quickSwitchShortcutRecorderRef = useRef<HTMLButtonElement | null>(null);
	const quickSwitchShortcutTriggerRef = useRef<HTMLButtonElement | null>(null);
	const quickSwitchShortcut = normalizeTasksQuickSwitchShortcut(
		globalSettings.tasksQuickSwitchShortcut,
		globalSettings.tasksQuickSwitchShortcutModifier,
	);
	const selectedQuickSwitchFilters = normalizeTasksQuickSwitchFilters(
		globalSettings.tasksQuickSwitchFilters ??
			globalSettings.tasksQuickSwitchStatuses,
	);
	const selectedQuickSwitchFilterSet = new Set(selectedQuickSwitchFilters);
	const quickSwitchTaskTypeOptions = useMemo<QuickSwitchTaskTypeOption[]>(
		() => [
			...TASKS_QUICK_SWITCH_FILTER_STATUSES.map((status) => ({
				id: status,
				label: t(statusKey(status)),
				color: statusColors[status],
			})),
			...projects
				.filter((project) => !project.deleted)
				.flatMap((project) =>
					(project.customColumns ?? []).map((column) => ({
						id: makeTasksQuickSwitchCustomFilter(column.id),
						label: `${project.name} / ${column.name}`,
						color: column.color,
					})),
				),
		],
		[projects, statusColors, t],
	);
	const isCustomQuickSwitchShortcut =
		!isPresetTasksQuickSwitchShortcut(quickSwitchShortcut, "alt") &&
		!isPresetTasksQuickSwitchShortcut(quickSwitchShortcut, "ctrl");

	useEffect(() => {
		if (!isQuickSwitchShortcutModalOpen || !isRecordingQuickSwitchShortcut) {
			return;
		}
		quickSwitchShortcutRecorderRef.current?.focus();
	}, [isQuickSwitchShortcutModalOpen, isRecordingQuickSwitchShortcut]);

	function restoreQuickSwitchShortcutTrigger() {
		const restore = () => {
			const trigger = quickSwitchShortcutTriggerRef.current;
			if (!trigger) return;
			trigger.scrollIntoView({
				block: "center",
				inline: "nearest",
			});
			try {
				trigger.focus({ preventScroll: true });
			} catch {
				trigger.focus();
			}
		};

		if (typeof window !== "undefined" && window.requestAnimationFrame) {
			window.requestAnimationFrame(restore);
			return;
		}

		setTimeout(restore, 0);
	}

	function handleQuickSwitchShortcutPreset(shortcut: TasksQuickSwitchShortcut) {
		setIsQuickSwitchShortcutModalOpen(false);
		setIsRecordingQuickSwitchShortcut(false);
		setQuickSwitchShortcutDraft(null);
		setQuickSwitchShortcutError(null);
		onTasksQuickSwitchShortcutChange(shortcut);
	}

	function openQuickSwitchShortcutModal() {
		setQuickSwitchShortcutDraft(quickSwitchShortcut);
		setQuickSwitchShortcutError(null);
		setIsQuickSwitchShortcutModalOpen(true);
		setIsRecordingQuickSwitchShortcut(true);
	}

	function closeQuickSwitchShortcutModal(options?: { restoreTrigger?: boolean }) {
		setIsQuickSwitchShortcutModalOpen(false);
		setIsRecordingQuickSwitchShortcut(false);
		setQuickSwitchShortcutDraft(null);
		setQuickSwitchShortcutError(null);
		if (options?.restoreTrigger) {
			restoreQuickSwitchShortcutTrigger();
		}
	}

	function saveQuickSwitchShortcutDraft() {
		if (!quickSwitchShortcutDraft) {
			setQuickSwitchShortcutError(
				t("settings.tasksQuickSwitchShortcutInvalid"),
			);
			return;
		}
		onTasksQuickSwitchShortcutChange(quickSwitchShortcutDraft);
		closeQuickSwitchShortcutModal({ restoreTrigger: true });
	}

	function handleQuickSwitchShortcutRecorderKeyDown(
		event: ReactKeyboardEvent<HTMLButtonElement>,
	) {
		event.preventDefault();
		event.stopPropagation();

		if (
			event.key === "Escape" &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey &&
			!event.shiftKey
		) {
			closeQuickSwitchShortcutModal({ restoreTrigger: true });
			return;
		}
		if (
			event.key === "Control" ||
			event.key === "Alt" ||
			event.key === "Shift" ||
			event.key === "Meta"
		) {
			setQuickSwitchShortcutError(null);
			return;
		}

		const recordedShortcut =
			getTasksQuickSwitchShortcutFromKeyboardEvent(event);
		if (!recordedShortcut) {
			setQuickSwitchShortcutError(
				t("settings.tasksQuickSwitchShortcutInvalid"),
			);
			return;
		}

		setQuickSwitchShortcutDraft(recordedShortcut);
		setIsRecordingQuickSwitchShortcut(false);
		setQuickSwitchShortcutError(null);
	}

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

			<div>
				<label className="block text-fg text-sm font-semibold mb-2">
					{t("settings.tasksQuickSwitch")}
				</label>
				<p className="text-fg-3 text-sm mb-3">
					{t("settings.tasksQuickSwitchDesc")}
				</p>
				<div className="mb-4">
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("settings.tasksQuickSwitchShortcut")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.tasksQuickSwitchShortcutDesc")}
					</p>
					<div className="flex flex-wrap gap-2">
						<ShortcutOptionButton
							label={t("settings.tasksQuickSwitchShortcutAlt")}
							active={isPresetTasksQuickSwitchShortcut(
								quickSwitchShortcut,
								"alt",
							)}
							onClick={() =>
								handleQuickSwitchShortcutPreset(
									ALT_TAB_QUICK_SWITCH_SHORTCUT,
								)
							}
						/>
						<ShortcutOptionButton
							label={t("settings.tasksQuickSwitchShortcutCtrl")}
							active={isPresetTasksQuickSwitchShortcut(
								quickSwitchShortcut,
								"ctrl",
							)}
							onClick={() =>
								handleQuickSwitchShortcutPreset(
									CTRL_TAB_QUICK_SWITCH_SHORTCUT,
								)
							}
						/>
						<ShortcutOptionButton
							label={t("settings.tasksQuickSwitchShortcutCustom")}
							active={isCustomQuickSwitchShortcut}
							buttonRef={quickSwitchShortcutTriggerRef}
							onClick={openQuickSwitchShortcutModal}
						/>
					</div>
					<div
						aria-label={t("settings.tasksQuickSwitchShortcutCurrent")}
						className="mt-3 w-full rounded-xl border border-edge bg-raised px-3 py-2.5 text-left text-sm text-fg"
					>
						{formatTasksQuickSwitchShortcut(quickSwitchShortcut, t)}
					</div>
					<p className="mt-2 text-xs text-fg-muted">
						{t("settings.tasksQuickSwitchShortcutHint")}
					</p>
				</div>
				<div className="flex flex-wrap gap-1.5">
					{quickSwitchTaskTypeOptions.map((option) => {
						const isSelected = selectedQuickSwitchFilterSet.has(option.id);
						return (
							<button
								key={option.id}
								type="button"
								onClick={() =>
									onTasksQuickSwitchFiltersChange(
										toggleQuickSwitchFilter(
											selectedQuickSwitchFilters,
											option.id,
										),
									)
								}
								className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition-colors ${
									isSelected
										? "border-accent bg-accent/10 text-accent"
										: "border-edge bg-raised text-fg-2 hover:border-edge-active"
								}`}
							>
								<span
									className="h-1.5 w-1.5 rounded-full shrink-0"
									style={{ backgroundColor: option.color }}
								/>
								<span className="truncate max-w-[15rem]">
									{option.label}
								</span>
							</button>
						);
					})}
				</div>
			</div>
			{isQuickSwitchShortcutModalOpen && typeof document !== "undefined"
					? createPortal(
						<div
							{...{ [TASKS_QUICK_SWITCH_SHORTCUT_MODAL_ATTR]: "true" }}
							className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4"
						>
							<div
								role="dialog"
								aria-modal="true"
							aria-label={t("settings.tasksQuickSwitchShortcutModalTitle")}
							className="w-full max-w-md rounded-2xl border border-edge bg-overlay/95 p-5 shadow-2xl backdrop-blur-xl"
						>
						<div className="text-fg text-base font-semibold">
							{t("settings.tasksQuickSwitchShortcutModalTitle")}
						</div>
						<p className="mt-2 text-sm text-fg-3">
							{t("settings.tasksQuickSwitchShortcutModalDesc")}
						</p>
						<div className="mt-4">
							<div className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
								{t("settings.tasksQuickSwitchShortcutCurrent")}
							</div>
							<div className="mt-2 rounded-xl border border-edge bg-raised px-3 py-2.5 text-sm text-fg">
								{formatTasksQuickSwitchShortcut(
									quickSwitchShortcutDraft ?? quickSwitchShortcut,
									t,
								)}
							</div>
						</div>
						<button
							type="button"
							ref={quickSwitchShortcutRecorderRef}
							{...{ [TASKS_QUICK_SWITCH_SHORTCUT_RECORDER_ATTR]: "true" }}
							aria-label={t("settings.tasksQuickSwitchShortcutRecorder")}
							onClick={() => {
								setIsRecordingQuickSwitchShortcut(true);
								setQuickSwitchShortcutError(null);
							}}
							onKeyDown={handleQuickSwitchShortcutRecorderKeyDown}
							className={`mt-4 w-full rounded-xl border px-3 py-3 text-left text-sm transition-colors ${
								isRecordingQuickSwitchShortcut
									? "border-accent bg-accent/10 text-accent"
									: "border-edge bg-raised text-fg hover:border-edge-active"
							}`}
						>
							{isRecordingQuickSwitchShortcut
								? t("settings.tasksQuickSwitchShortcutRecording")
								: t("settings.tasksQuickSwitchShortcutRecordNew")}
						</button>
						{quickSwitchShortcutError ? (
							<p className="mt-2 text-xs text-danger">
								{quickSwitchShortcutError}
							</p>
						) : (
							<p className="mt-2 text-xs text-fg-muted">
								{t("settings.tasksQuickSwitchShortcutModalHint")}
							</p>
						)}
						<div className="mt-5 flex justify-end gap-3">
							<button
								type="button"
								onClick={() =>
									closeQuickSwitchShortcutModal({ restoreTrigger: true })
								}
								className="rounded-xl border border-edge bg-raised px-4 py-2 text-sm text-fg hover:border-edge-active"
							>
								{t("task.editCancel")}
							</button>
							<button
								type="button"
								onClick={saveQuickSwitchShortcutDraft}
								className="rounded-xl border border-accent bg-accent/10 px-4 py-2 text-sm text-accent hover:bg-accent/15"
							>
								{t("task.editSave")}
							</button>
						</div>
					</div>
					</div>,
					document.body,
				)
				: null}

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

function ShortcutOptionButton({
	label,
	active,
	buttonRef,
	onClick,
}: {
	label: string;
	active: boolean;
	buttonRef?: Ref<HTMLButtonElement>;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			ref={buttonRef}
			onClick={onClick}
			className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
				active
					? "border-accent bg-accent/10 text-accent"
					: "border-edge bg-raised text-fg hover:border-edge-active"
			}`}
		>
			{label}
		</button>
	);
}
