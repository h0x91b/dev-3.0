import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Project, Task, TmuxPaneInfo, ScheduledMessageTarget } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useFileDrop } from "../hooks/useFileDrop";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { removeImagePath } from "../utils/imageAttachments";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import SchedulePicker from "./SchedulePicker";

interface ScheduleMessageModalProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
	/** Seed text (e.g. the browser/touch composer's current draft). */
	initialText?: string;
}

/** Target-selector value: "agent" (default role) or a concrete pane id. */
type TargetValue = "agent" | string;

/**
 * "Send later" — queue a one-shot message to a task's live agent, delivered at a
 * chosen wall-clock time / after a delay. Reuses the shared {@link SchedulePicker}
 * (in/at). Enter in the textarea inserts a newline; submit is button-only, so a
 * long multi-line prompt can't be sent by accident (mirrors the launch modal).
 * Images can be dropped or pasted into the textarea — they upload into the task
 * worktree and their relative path is inserted into the message (same mechanism
 * as the task description editor / terminal drop).
 */
function ScheduleMessageModal({ task, project, dispatch, onClose, initialText }: ScheduleMessageModalProps) {
	const t = useT();
	const [text, setText] = useState(initialText ?? "");
	const [scheduleTarget, setScheduleTarget] = useState<Date | null>(null);
	const [targetValue, setTargetValue] = useState<TargetValue>("agent");
	const [panes, setPanes] = useState<TmuxPaneInfo[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const taRef = useRef<HTMLTextAreaElement>(null);

	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);

	// Insert an uploaded worktree-relative path at the cursor (or at the end),
	// on its own line — same convention as the description editor.
	const insertPathAtCursor = useCallback((path: string) => {
		setText((prev) => {
			const el = taRef.current;
			if (!el) return prev ? `${prev}\n${path}\n` : `${path}\n`;
			const start = el.selectionStart;
			const end = el.selectionEnd;
			const prefix = start > 0 && prev[start - 1] !== "\n" ? "\n" : "";
			const insert = prefix + path + "\n";
			const next = prev.slice(0, start) + insert + prev.slice(end);
			requestAnimationFrame(() => {
				const pos = start + insert.length;
				el.selectionStart = pos;
				el.selectionEnd = pos;
				el.focus();
			});
			return next;
		});
	}, []);

	const handleRemovePath = useCallback((path: string) => {
		setText((prev) => removeImagePath(prev, path));
	}, []);

	const { handlePaste, isPasting, pasteKind } = useClipboardPaste(project.id, insertPathAtCursor);
	const { handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging } = useFileDrop(project.id, insertPathAtCursor, task.id);

	// Load the task's live panes for the (optional) concrete-pane target. Failure
	// is non-fatal — the default agent target always works.
	useEffect(() => {
		let cancelled = false;
		api.request.tmuxLayout({ taskId: task.id })
			.then((layout) => { if (!cancelled) setPanes(layout.panes ?? []); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [task.id]);

	// Focus the message field on open so the user can type immediately.
	useEffect(() => {
		taRef.current?.focus();
	}, []);

	const canSubmit = !submitting && text.trim().length > 0 && scheduleTarget != null;

	async function handleSubmit() {
		if (!canSubmit || !scheduleTarget) return;
		setSubmitting(true);
		setError(null);
		const target: ScheduledMessageTarget = targetValue === "agent" ? { kind: "agent" } : { kind: "pane", paneId: targetValue };
		try {
			const updated = await api.request.scheduleMessage({
				taskId: task.id,
				projectId: project.id,
				at: scheduleTarget.toISOString(),
				text: text.trim(),
				target,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("scheduled_message_created", {
				project_id: project.id,
				delay_ms: scheduleTarget.getTime() - Date.now(),
				target_kind: target.kind,
			});
			onClose();
		} catch (err) {
			setError(String(err));
			setSubmitting(false);
		}
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-2xl mx-4 overflow-hidden outline-none max-sm:h-full max-sm:max-w-none max-sm:mx-0 max-sm:rounded-none max-sm:flex max-sm:flex-col"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<h2 className="text-fg text-lg font-semibold">{t("scheduleMessage.title")}</h2>
					<p className="text-fg-3 text-sm mt-1 truncate">{getTaskTitle(task)}</p>
				</div>

				{/* Body */}
				<div className="px-6 py-4 space-y-4 max-sm:flex-1 max-sm:overflow-y-auto">
					<div
						className="relative"
						onDragOver={handleDragOver}
						onDragEnter={handleDragEnter}
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
					>
						{isDragging && (
							<div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 pointer-events-none">
								<div className="flex items-center gap-2 text-accent font-medium text-sm">
									<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
									</svg>
									{t("images.dropHere")}
								</div>
							</div>
						)}
						<textarea
							ref={taRef}
							value={text}
							onChange={(e) => setText(e.target.value)}
							onPaste={handlePaste}
							placeholder={t("scheduleMessage.placeholder")}
							rows={4}
							data-testid="schedule-message-input"
							className="w-full resize-none rounded-xl bg-raised text-fg text-sm leading-relaxed px-3 py-2.5 border border-edge focus:border-accent outline-none placeholder:text-fg-muted"
						/>
					</div>

					{isPasting && (
						<span className="text-[0.6875rem] text-accent animate-pulse">
							{t(pasteKind === "text" ? "paste.savingText" : "images.pasting")}
						</span>
					)}

					<ImageAttachmentsStrip text={text} onRemovePath={handleRemovePath} />

					{/* Delivery target — agent by default; optionally a concrete live pane. */}
					{panes.length > 0 && (
						<div className="flex items-center gap-3">
							<span className="text-fg-3 text-xs whitespace-nowrap">{t("scheduleMessage.deliverTo")}</span>
							<div className="relative">
								<select
									value={targetValue}
									aria-label={t("scheduleMessage.deliverTo")}
									onChange={(e) => setTargetValue(e.target.value)}
									className="appearance-none bg-elevated border border-edge rounded-lg pl-2.5 pr-8 h-8 text-fg text-sm outline-none focus:border-accent cursor-pointer hover:bg-elevated-hover transition-colors"
								>
									<option value="agent">{t("scheduleMessage.targetAgent")}</option>
									{panes.map((p) => (
										<option key={p.paneId} value={p.paneId}>
											{t("scheduleMessage.paneOption", { pane: p.paneId, cmd: p.command || "?" })}
										</option>
									))}
								</select>
								<svg
									className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-3"
									fill="none" stroke="currentColor" viewBox="0 0 24 24"
								>
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
							</div>
						</div>
					)}

					<SchedulePicker
						disabled={submitting}
						hintKey="scheduleMessage.scheduleHint"
						onTargetChange={(target) => setScheduleTarget(target)}
					/>
				</div>

				{/* Error */}
				{error && (
					<div className="px-6 py-2 text-danger text-sm">
						{t("scheduleMessage.failed", { error })}
					</div>
				)}

				{/* Footer */}
				<div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-3">
					<button
						onClick={onClose}
						disabled={submitting}
						className="text-fg-3 hover:text-fg text-sm transition-colors px-3 py-1.5"
					>
						{t("kanban.cancel")}
					</button>
					<button
						onClick={handleSubmit}
						disabled={!canSubmit}
						className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
					>
						{submitting ? t("scheduleMessage.scheduling") : t("scheduleMessage.schedule")}
					</button>
				</div>
			</div>
		</div>
	);
}

export default ScheduleMessageModal;
