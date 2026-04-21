import { useMemo } from "react";
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
import QuickSwitchShortcutSettings from "./QuickSwitchShortcutSettings";

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

	return (
		<div>
			<label className="block text-fg text-sm font-semibold mb-2">
				{t("settings.tasksQuickSwitch")}
			</label>
			<p className="text-fg-3 text-sm mb-3">
				{t("settings.tasksQuickSwitchDesc")}
			</p>
			<QuickSwitchShortcutSettings
				t={t}
				shortcut={quickSwitchShortcut}
				onShortcutChange={onTasksQuickSwitchShortcutChange}
			/>
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
		</div>
	);
}
