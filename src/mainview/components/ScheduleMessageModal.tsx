import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Project, Task, TmuxPaneInfo, ScheduledMessageTarget } from "../../shared/types";
import { getTaskTitle, MESSAGE_DRAFT_CHANGED_ERROR } from "../../shared/types";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useFileDrop } from "../hooks/useFileDrop";
import { useClipboardPaste } from "../hooks/useClipboardPaste";
import { removeImagePath } from "../utils/imageAttachments";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import HelpSpot from "./HelpSpot";
import { trackEvent } from "../analytics";
import { toast } from "../toast";
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

/** How the message leaves: kept as a note, typed now, armed for the agent's next stop, or queued on the clock. */
type Delivery = "draft" | "now" | "stop" | "later";

/** Typing pause before the draft is written to the task. */
const DRAFT_SAVE_DELAY_MS = 500;

/**
 * "Send later" — compose a message to a task's live agent outside its terminal,
 * then send it now, when the agent next stops, or at a time (the shared
 * {@link SchedulePicker}). The text autosaves as the task's message draft, so a
 * held peer message can never submit it and closing never loses it (#2281).
 * Enter in the textarea inserts a newline; submit is button-only, so a
 * long multi-line prompt can't be sent by accident (mirrors the launch modal).
 * Images can be dropped or pasted into the textarea — they upload into the task
 * worktree and their relative path is inserted into the message (same mechanism
 * as the task description editor / terminal drop).
 */
function ScheduleMessageModal({ task, project, dispatch, onClose, initialText }: ScheduleMessageModalProps) {
	const t = useT();
	const savedDraft = task.messageDraft?.text ?? "";
	const seed = initialText?.trim() ?? "";
	const [text, setText] = useState(savedDraft && seed ? `${savedDraft}\n\n${seed}` : savedDraft || seed);
	// Never a send by default: a reopened armed draft stays armed, anything else is a note.
	const [delivery, setDelivery] = useState<Delivery>(task.messageDraft?.sendOnStop ? "stop" : "draft");
	const [scheduleTarget, setScheduleTarget] = useState<Date | null>(null);
	const [targetValue, setTargetValue] = useState<TargetValue>("agent");
	const [panes, setPanes] = useState<TmuxPaneInfo[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const taRef = useRef<HTMLTextAreaElement>(null);
	// State updates land a render late; a ref closes the double-click window.
	const submittingRef = useRef(false);
	// What the task already holds, so autosave and the unmount flush skip a no-op write.
	const lastSavedRef = useRef<string | null>(savedDraft);
	const textRef = useRef(text);
	textRef.current = text;
	const armedRef = useRef(false);
	armedRef.current = !!task.messageDraft?.sendOnStop;
	// The draft version this window last read or wrote; every save builds on it (compare-and-set).
	const baseVersionRef = useRef<string | null>(task.messageDraft?.updatedAt ?? null);
	const latestVersionRef = useRef<string | null>(null);
	latestVersionRef.current = task.messageDraft?.updatedAt ?? null;

	const trapRef = useFocusTrap<HTMLDivElement>();

	// Writes go out one at a time, so an autosave still in flight can never land after a Discard or a send.
	const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
	/** `strict` (a button) refuses when the draft moved on; an autosave keeps the text as a note instead. */
	const persistDraft = useCallback((value: string, sendOnStop: boolean, opts?: { strict: boolean }) => {
		const run = saveChainRef.current.catch(() => {}).then(async () => {
			const updated = await api.request.saveMessageDraft({
				taskId: task.id,
				projectId: project.id,
				text: value,
				sendOnStop,
				expectedUpdatedAt: baseVersionRef.current,
				...(opts?.strict ? { strict: true } : {}),
			});
			baseVersionRef.current = updated.messageDraft?.updatedAt ?? null;
			dispatch({ type: "updateTask", task: updated });
		});
		saveChainRef.current = run;
		return run;
	}, [task.id, project.id, dispatch]);

	const autosave = useCallback((value: string) => {
		if (value === lastSavedRef.current) return;
		lastSavedRef.current = value;
		persistDraft(value, armedRef.current).catch((err) => {
			// Still unsaved, so the close-time flush tries again.
			if (lastSavedRef.current === value) lastSavedRef.current = null;
			toast.error(t("scheduleMessage.draftSaveFailed", { error: String(err) }), { taskId: task.id });
		});
	}, [persistDraft, t, task.id]);

	useEffect(() => {
		const timer = setTimeout(() => autosave(text), DRAFT_SAVE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [text, autosave]);

	// However the modal goes away, the last keystrokes reach the task.
	useEffect(() => () => autosave(textRef.current), [autosave]);

	function requestClose() {
		if (submittingRef.current) return;
		onClose();
	}

	useEscapeKey(requestClose);

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

	// Load live tmux panes for the (optional) concrete-pane target selector.
	// tmuxLayout is tmux-only — skip entirely for native tasks so we never fire
	// a session query against a backend that has no tmux session.
	useEffect(() => {
		if (task.terminalBackend === "native") return;
		let cancelled = false;
		api.request.tmuxLayout({ taskId: task.id })
			.then((layout) => { if (!cancelled) setPanes(layout.panes ?? []); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [task.id, task.terminalBackend]);

	// Focus the message field on open so the user can type immediately.
	useEffect(() => {
		taRef.current?.focus();
	}, []);

	const canSubmit = !submitting && text.trim().length > 0 && (delivery !== "later" || scheduleTarget != null);
	const hasDraft = !!task.messageDraft || text.trim().length > 0;
	const draftSaved = text.trim().length > 0 && task.messageDraft?.text === text;

	/** Runs one submit path; the text it handled must not be re-saved by the unmount flush. */
	async function submitWith(action: () => Promise<void>) {
		if (submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		setError(null);
		// Claimed before the await, so a debounced autosave cannot overwrite what the action writes.
		const previous = lastSavedRef.current;
		lastSavedRef.current = textRef.current;
		try {
			await action();
			onClose();
		} catch (err) {
			lastSavedRef.current = previous;
			if (String(err).includes(MESSAGE_DRAFT_CHANGED_ERROR)) {
				// Shown once: the next click saves this text over what the draft is now.
				baseVersionRef.current = latestVersionRef.current;
				setError(t("scheduleMessage.draftChanged"));
			} else {
				setError(String(err));
			}
			submittingRef.current = false;
			setSubmitting(false);
		}
	}

	function handleSubmit() {
		if (!canSubmit) return;
		void submitWith(async () => {
			if (delivery === "draft") {
				await persistDraft(text, false, { strict: true });
				return;
			}
			if (delivery === "now") {
				await persistDraft(text, false, { strict: true });
				dispatch({ type: "updateTask", task: await api.request.sendMessageDraft({ taskId: task.id, projectId: project.id }) });
				return;
			}
			if (delivery === "stop") {
				await persistDraft(text, true, { strict: true });
				return;
			}
			if (!scheduleTarget) return;
			const target: ScheduledMessageTarget = targetValue === "agent" ? { kind: "agent" } : { kind: "pane", paneId: targetValue };
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
			// The text now lives in the queue; a draft copy would be sent twice.
			if (task.messageDraft) await persistDraft("", false);
		});
	}

	function handleDiscard() {
		void submitWith(() => persistDraft("", false));
	}

	const submitLabel = delivery === "draft"
		? t("scheduleMessage.keepDraft")
		: delivery === "now"
		? t("task.sendNow")
		: delivery === "stop"
			? t("scheduleMessage.saveOnStop")
			: submitting ? t("scheduleMessage.scheduling") : t("scheduleMessage.schedule");

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={(e) => e.stopPropagation()}
			// mousedown, not click: a text selection released over the backdrop
			// dispatches its click here too and would read as "close".
			onMouseDown={(e) => {
				if (e.target !== e.currentTarget) return;
				e.preventDefault(); // keep focus inside the dialog, not on <body>
				requestClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="schedule-message-title"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-2xl mx-4 overflow-hidden outline-none max-sm:h-full max-sm:max-w-none max-sm:mx-0 max-sm:rounded-none max-sm:flex max-sm:flex-col"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<div className="flex items-center gap-1.5">
						<h2 id="schedule-message-title" className="text-fg text-lg font-semibold">{t("scheduleMessage.title")}</h2>
						<HelpSpot topicId="modal.schedule-message" />
					</div>
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
						<span className="text-micro text-accent animate-pulse">
							{t(pasteKind === "text" ? "paste.savingText" : "images.pasting")}
						</span>
					)}

					<ImageAttachmentsStrip text={text} onRemovePath={handleRemovePath} />

					{draftSaved && <p className="text-micro text-fg-3" data-testid="message-draft-saved">{t("scheduleMessage.draftSaved")}</p>}

					{/* Delivery target — agent by default; optionally a concrete live pane. */}
					{delivery === "later" && panes.length > 0 && (
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
						extraModes={[
							{ id: "draft", label: t("scheduleMessage.modeDraft"), leading: true, content: <p className="text-sm text-fg-3">{t("scheduleMessage.draftHint")}</p> },
							{ id: "now", label: t("scheduleMessage.modeNow"), leading: true, content: <p className="text-sm text-fg-3">{t("scheduleMessage.nowHint")}</p> },
							{ id: "stop", label: t("scheduleMessage.modeStop"), leading: true, content: <p className="text-sm text-fg-3">{t("scheduleMessage.stopHint")}</p> },
						]}
						initialExtraMode={delivery}
						onExtraModeChange={(id) => setDelivery(id === "draft" || id === "now" || id === "stop" ? id : "later")}
					/>
				</div>

				{/* Error */}
				{error && (
					<div className="px-6 py-2 text-danger text-sm">
						{t("scheduleMessage.failed", { error })}
					</div>
				)}

				{/* Footer */}
				<div className="px-6 py-4 border-t border-edge flex items-center gap-3">
					{hasDraft && (
						<button
							onClick={handleDiscard}
							disabled={submitting}
							data-testid="message-draft-discard"
							className="text-danger hover:opacity-80 text-sm transition-opacity px-3 py-1.5 disabled:opacity-50"
						>
							{t("task.draftDiscard")}
						</button>
					)}
					<div className="flex-1" />
					<button
						onClick={requestClose}
						disabled={submitting}
						className="text-fg-2 hover:text-fg text-sm transition-colors px-3 py-1.5 disabled:opacity-50"
					>
						{t("common.close")}
					</button>
					<button
						onClick={handleSubmit}
						disabled={!canSubmit}
						data-testid="schedule-message-submit"
						className="bg-accent-fill hover:bg-accent-fill-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
					>
						{submitLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

export default ScheduleMessageModal;
