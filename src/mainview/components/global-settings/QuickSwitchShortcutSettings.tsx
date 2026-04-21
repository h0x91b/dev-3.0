import {
	useEffect,
	useRef,
	useState,
	type Ref,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { TasksQuickSwitchShortcut } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import {
	ALT_TAB_QUICK_SWITCH_SHORTCUT,
	CTRL_TAB_QUICK_SWITCH_SHORTCUT,
	formatTasksQuickSwitchShortcut,
	getTasksQuickSwitchShortcutFromKeyboardEvent,
	isPresetTasksQuickSwitchShortcut,
} from "../../tasks-quick-switch-shortcut";
import QuickSwitchShortcutModal from "./QuickSwitchShortcutModal";

interface QuickSwitchShortcutSettingsProps {
	t: TFunction;
	shortcut: TasksQuickSwitchShortcut;
	onShortcutChange: (shortcut: TasksQuickSwitchShortcut) => void;
}

export default function QuickSwitchShortcutSettings({
	t,
	shortcut,
	onShortcutChange,
}: QuickSwitchShortcutSettingsProps) {
	const [isShortcutModalOpen, setIsShortcutModalOpen] = useState(false);
	const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
	const [shortcutDraft, setShortcutDraft] =
		useState<TasksQuickSwitchShortcut | null>(null);
	const [shortcutError, setShortcutError] = useState<string | null>(null);
	const shortcutRecorderRef = useRef<HTMLButtonElement | null>(null);
	const shortcutTriggerRef = useRef<HTMLButtonElement | null>(null);
	const isCustomShortcut =
		!isPresetTasksQuickSwitchShortcut(shortcut, "alt") &&
		!isPresetTasksQuickSwitchShortcut(shortcut, "ctrl");

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

	function handleShortcutPreset(nextShortcut: TasksQuickSwitchShortcut) {
		setIsShortcutModalOpen(false);
		setIsRecordingShortcut(false);
		setShortcutDraft(null);
		setShortcutError(null);
		onShortcutChange(nextShortcut);
	}

	function openShortcutModal() {
		setShortcutDraft(shortcut);
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
		onShortcutChange(shortcutDraft);
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
		<>
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
						active={isPresetTasksQuickSwitchShortcut(shortcut, "alt")}
						onClick={() => handleShortcutPreset(ALT_TAB_QUICK_SWITCH_SHORTCUT)}
					/>
					<ShortcutOptionButton
						label={t("settings.tasksQuickSwitchShortcutCtrl")}
						active={isPresetTasksQuickSwitchShortcut(shortcut, "ctrl")}
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
					{formatTasksQuickSwitchShortcut(shortcut, t)}
				</div>
				<p className="mt-2 text-xs text-fg-muted">
					{t("settings.tasksQuickSwitchShortcutHint")}
				</p>
			</div>
			{isShortcutModalOpen ? (
				<QuickSwitchShortcutModal
					t={t}
					shortcut={shortcut}
					shortcutDraft={shortcutDraft}
					isRecordingShortcut={isRecordingShortcut}
					shortcutError={shortcutError}
					shortcutRecorderRef={shortcutRecorderRef}
					onStartRecording={() => {
						setIsRecordingShortcut(true);
						setShortcutError(null);
					}}
					onRecorderKeyDown={handleShortcutRecorderKeyDown}
					onCancel={() =>
						closeShortcutModal({ restoreTrigger: true })
					}
					onSave={saveShortcutDraft}
				/>
			) : null}
		</>
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
