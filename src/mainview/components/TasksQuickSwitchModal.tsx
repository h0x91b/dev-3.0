import { useEffect, useRef } from "react";
import { useT, statusKey } from "../i18n";
import { createPortal } from "react-dom";
import { useStatusColors } from "../hooks/useStatusColors";
import type { TasksQuickSwitchItem } from "../tasks-quick-switch";
import type { TasksQuickSwitchShortcut } from "../../shared/types";
import {
	formatTasksQuickSwitchShortcutModifiers,
} from "../tasks-quick-switch-shortcut";

interface TasksQuickSwitchModalProps {
	items: TasksQuickSwitchItem[];
	selectedIndex: number;
	shortcut: TasksQuickSwitchShortcut;
}

function TasksQuickSwitchModal({
	items,
	selectedIndex,
	shortcut,
}: TasksQuickSwitchModalProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const shortcutLabel = formatTasksQuickSwitchShortcutModifiers(shortcut, t);
	const selectedOptionRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		selectedOptionRef.current?.scrollIntoView({
			block: "nearest",
		});
	}, [selectedIndex]);

	const content = (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 pointer-events-none">
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t("quickSwitch.title")}
				className="w-[30rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] rounded-3xl border border-edge bg-overlay/95 shadow-2xl backdrop-blur-xl overflow-hidden flex flex-col"
			>
				<div className="px-5 py-4 border-b border-edge">
					<div className="text-fg text-base font-semibold">
						{t("quickSwitch.title")}
					</div>
					<div className="mt-1 text-fg-3 text-xs">
						{t("quickSwitch.hint", { shortcut: shortcutLabel })}
					</div>
				</div>

				{items.length === 0 ? (
					<div className="px-5 py-6 text-sm text-fg-3">
						{t("quickSwitch.empty")}
					</div>
				) : (
					<div
						role="listbox"
						aria-label={t("quickSwitch.title")}
						className="p-2 max-h-[26rem] overflow-y-auto"
					>
						{items.map((item, index) => {
							const isSelected = index === selectedIndex;
							return (
								<div
									key={item.taskId}
									role="option"
									aria-selected={isSelected}
									ref={isSelected ? selectedOptionRef : null}
									className={`flex items-center gap-3 rounded-2xl px-3 py-3 transition-colors ${
										isSelected
											? "bg-accent/20 border border-accent/40"
											: "border border-transparent"
									}`}
								>
									<span
										className="w-2.5 h-2.5 rounded-full shrink-0"
										style={{
											backgroundColor:
												item.customColumnColor ??
												statusColors[item.status],
										}}
									/>
									<div className="min-w-0 flex-1">
										<div className="text-fg text-sm font-semibold truncate">
											{item.projectName}
										</div>
										<div className="text-fg-2 text-sm truncate">
											{item.taskTitle}
										</div>
									</div>
									<div
										className="text-xs shrink-0"
										style={{
											color:
												item.customColumnColor ??
												statusColors[item.status],
										}}
									>
										{item.customColumnName ?? t(statusKey(item.status))}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);

	if (typeof document === "undefined") {
		return content;
	}

	return createPortal(content, document.body);
}

export default TasksQuickSwitchModal;
