import { createPortal } from "react-dom";
import type { KeyboardEventHandler, Ref } from "react";
import type { TasksQuickSwitchShortcut } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import {
	formatTasksQuickSwitchShortcut,
	TASKS_QUICK_SWITCH_SHORTCUT_MODAL_ATTR,
	TASKS_QUICK_SWITCH_SHORTCUT_RECORDER_ATTR,
} from "../../tasks-quick-switch-shortcut";

interface QuickSwitchShortcutModalProps {
	t: TFunction;
	shortcut: TasksQuickSwitchShortcut;
	shortcutDraft: TasksQuickSwitchShortcut | null;
	isRecordingShortcut: boolean;
	shortcutError: string | null;
	shortcutRecorderRef: Ref<HTMLButtonElement>;
	onStartRecording: () => void;
	onRecorderKeyDown: KeyboardEventHandler<HTMLButtonElement>;
	onCancel: () => void;
	onSave: () => void;
}

export default function QuickSwitchShortcutModal({
	t,
	shortcut,
	shortcutDraft,
	isRecordingShortcut,
	shortcutError,
	shortcutRecorderRef,
	onStartRecording,
	onRecorderKeyDown,
	onCancel,
	onSave,
}: QuickSwitchShortcutModalProps) {
	if (typeof document === "undefined") {
		return null;
	}

	return createPortal(
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
						{formatTasksQuickSwitchShortcut(shortcutDraft ?? shortcut, t)}
					</div>
				</div>
				<button
					type="button"
					ref={shortcutRecorderRef}
					{...{ [TASKS_QUICK_SWITCH_SHORTCUT_RECORDER_ATTR]: "true" }}
					aria-label={t("settings.tasksQuickSwitchShortcutRecorder")}
					onClick={onStartRecording}
					onKeyDown={onRecorderKeyDown}
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
					<p className="mt-2 text-xs text-danger">{shortcutError}</p>
				) : (
					<p className="mt-2 text-xs text-fg-muted">
						{t("settings.tasksQuickSwitchShortcutModalHint")}
					</p>
				)}
				<div className="mt-5 flex justify-end gap-3">
					<button
						type="button"
						onClick={onCancel}
						className="rounded-xl border border-edge bg-raised px-4 py-2 text-sm text-fg hover:border-edge-active"
					>
						{t("task.editCancel")}
					</button>
					<button
						type="button"
						onClick={onSave}
						className="rounded-xl border border-accent bg-accent/10 px-4 py-2 text-sm text-accent hover:bg-accent/15"
					>
						{t("task.editSave")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
