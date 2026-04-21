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

interface TasksQuickSwitchSettingsProps {
	t: TFunction;
	globalSettings: GlobalSettings;
	projects: Project[];
	onTasksQuickSwitchShortcutChange: (
		shortcut: TasksQuickSwitchShortcut,
	) => void;
	onTasksQuickSwitchFiltersChange: (filters: TasksQuickSwitchFilter[]) => void;
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

export default function TasksQuickSwitchSettings({
	t,
	globalSettings,
	projects,
	onTasksQuickSwitchShortcutChange,
	onTasksQuickSwitchFiltersChange,
}: TasksQuickSwitchSettingsProps) {
	const statusColors = useStatusColors();
	const [isShortcutModalOpen, setIsShortcutModalOpen] = useState(false);
	const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
	const [shortcutDraft, setShortcutDraft] =
		useState<TasksQuickSwitchShortcut | null>(null);
	const [shortcutError, setShortcutError] = useState<string | null>(null);
	const shortcutRecorderRef = useRef<HTMLButtonElement | null>(null);
	const shortcutTriggerRef = useRef<HTMLButtonElement | null>(null);
	const quickSwitchShortcut = normalizeTasksQuickSwitchShortcut(
		globalSettings.tasksQuickSwitchShortcut,
		globalSettings.tasksQuickSwitchShortcutModifier,
	);
	const selectedFilters = normalizeTasksQuickSwitchFilters(
		globalSettings.tasksQuickSwitchFilters ??
			globalSettings.tasksQuickSwitchStatuses,
	);
	const selectedFilterSet = new Set(selectedFilters);
	const taskTypeOptions = useMemo<QuickSwitchTaskTypeOption[]>(
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
	const isCustomShortcut =
		!isPresetTasksQuickSwitchShortcut(quickSwitchShortcut, "alt") &&
		!isPresetTasksQuickSwitchShortcut(quickSwitchShortcut, "ctrl");

	useEffect(() => {
		if (!isShortcutModalOpen || !isRecordingShortcut) {
			return;
		}
		shortcutRecorderRef.current?.focus();
	}, [isRecordingShortcut, isShortcutModalOpen]);

	function restoreShortcutTrigger() {
		const restore = () => {
			const trigger = shortcutTriggerRef.current;
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

	function handleShortcutPreset(shortcut: TasksQuickSwitchShortcut) {
		setIsShortcutModalOpen(false);
		setIsRecordingShortcut(false);
		setShortcutDraft(null);
		setShortcutError(null);
		onTasksQuickSwitchShortcutChange(shortcut);
	}

	function openShortcutModal() {
		setShortcutDraft(quickSwitchShortcut);
		setShortcutError(null);
		setIsShortcutModalOpen(true);
		setIsRecordingShortcut(true);
	}

	function closeShortcutModal(options?: { restoreTrigger?: boolean }) {
		setIsShortcutModalOpen(false);
		setIsRecordingShortcut(false);
		setShortcutDraft(null);
		setShortcutError(null);
		if (options?.restoreTrigger) {
			restoreShortcutTrigger();
		}
	}

	function saveShortcutDraft() {
		if (!shortcutDraft) {
			setShortcutError(t("settings.tasksQuickSwitchShortcutInvalid"));
			return;
		}
		onTasksQuickSwitchShortcutChange(shortcutDraft);
		closeShortcutModal({ restoreTrigger: true });
	}

	function handleShortcutRecorderKeyDown(
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
			closeShortcutModal({ restoreTrigger: true });
			return;
		}
		if (
			event.key === "Control" ||
			event.key === "Alt" ||
			event.key === "Shift" ||
			event.key === "Meta"
		) {
			setShortcutError(null);
			return;
		}

		const recordedShortcut =
			getTasksQuickSwitchShortcutFromKeyboardEvent(event);
		if (!recordedShortcut) {
			setShortcutError(t("settings.tasksQuickSwitchShortcutInvalid"));
			return;
		}

		setShortcutDraft(recordedShortcut);
		setIsRecordingShortcut(false);
		setShortcutError(null);
	}

	return (
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
							handleShortcutPreset(ALT_TAB_QUICK_SWITCH_SHORTCUT)
						}
					/>
					<ShortcutOptionButton
						label={t("settings.tasksQuickSwitchShortcutCtrl")}
						active={isPresetTasksQuickSwitchShortcut(
							quickSwitchShortcut,
							"ctrl",
						)}
						onClick={() =>
							handleShortcutPreset(CTRL_TAB_QUICK_SWITCH_SHORTCUT)
						}
					/>
					<ShortcutOptionButton
						label={t("settings.tasksQuickSwitchShortcutCustom")}
						active={isCustomShortcut}
						buttonRef={shortcutTriggerRef}
						onClick={openShortcutModal}
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
				{taskTypeOptions.map((option) => {
					const isSelected = selectedFilterSet.has(option.id);
					return (
						<button
							key={option.id}
							type="button"
							onClick={() =>
								onTasksQuickSwitchFiltersChange(
									toggleQuickSwitchFilter(selectedFilters, option.id),
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
							<span className="truncate max-w-[15rem]">{option.label}</span>
						</button>
					);
				})}
			</div>
			{isShortcutModalOpen && typeof document !== "undefined"
				? createPortal(
						<div
							{...{ [TASKS_QUICK_SWITCH_SHORTCUT_MODAL_ATTR]: "true" }}
							className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4"
						>
							<div
								role="dialog"
								aria-modal="true"
								aria-label={t(
									"settings.tasksQuickSwitchShortcutModalTitle",
								)}
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
											shortcutDraft ?? quickSwitchShortcut,
											t,
										)}
									</div>
								</div>
								<button
									type="button"
									ref={shortcutRecorderRef}
									{...{ [TASKS_QUICK_SWITCH_SHORTCUT_RECORDER_ATTR]: "true" }}
									aria-label={t(
										"settings.tasksQuickSwitchShortcutRecorder",
									)}
									onClick={() => {
										setIsRecordingShortcut(true);
										setShortcutError(null);
									}}
									onKeyDown={handleShortcutRecorderKeyDown}
									className={`mt-4 w-full rounded-xl border px-3 py-3 text-left text-sm transition-colors ${
										isRecordingShortcut
											? "border-accent bg-accent/10 text-accent"
											: "border-edge bg-raised text-fg hover:border-edge-active"
									}`}
								>
									{isRecordingShortcut
										? t("settings.tasksQuickSwitchShortcutRecording")
										: t("settings.tasksQuickSwitchShortcutRecordNew")}
								</button>
								{shortcutError ? (
									<p className="mt-2 text-xs text-danger">
										{shortcutError}
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
											closeShortcutModal({ restoreTrigger: true })
										}
										className="rounded-xl border border-edge bg-raised px-4 py-2 text-sm text-fg hover:border-edge-active"
									>
										{t("task.editCancel")}
									</button>
									<button
										type="button"
										onClick={saveShortcutDraft}
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
		</div>
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
