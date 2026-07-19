import { useEffect, useRef, useState, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { TerminalHandle } from "../TerminalView";
import type { Project, Task } from "../../shared/types";
import { ACTIVE_STATUSES } from "../../shared/types";
import type { AppAction } from "../state";
import { useT } from "../i18n";
import { uploadDroppedFile } from "../utils/uploadDroppedFile";
import { toast } from "../toast";
import ScheduleMessageModal from "./ScheduleMessageModal";

interface TerminalComposerProps {
	handle: TerminalHandle;
	/**
	 * When a task context is supplied (the task terminal, not the project-level
	 * terminal), the composer shows a clock button that opens "Send later" seeded
	 * with the composer text — the browser/touch entry point for scheduling a
	 * message (no native menu there). Omitted in project terminals.
	 */
	task?: Task;
	project?: Project;
	dispatch?: Dispatch<AppAction>;
	/**
	 * Enables the attach button when no full `project` is available (the
	 * project-level terminal passes only the id). Uploads land in the project's
	 * worktree uploads dir via `uploadFileBase64`.
	 */
	projectId?: string;
}

/** Collapsed autogrow ceiling — roughly 4 lines of 16px text. */
const MAX_COLLAPSED_HEIGHT_PX = 120;
/** Ignore minor browser-chrome viewport shifts; a keyboard consumes much more space. */
const KEYBOARD_VIEWPORT_DELTA_PX = 80;

const NERD_FONT = "'JetBrainsMono Nerd Font Mono'";

/**
 * Docked chat-style composer for touch devices (browser mode). The terminal
 * itself never summons the on-screen keyboard in compose mode — prompts are
 * typed here (autocorrect/voice/swipe all work) and delivered to the PTY as a
 * paste-aware submit or insert operation. Insert leaves the text uncommitted
 * on the prompt. Expand turns the bar into a full-surface editor for long prompts.
 *
 * While the composer is focused, `<html data-composer-focused>` collapses
 * non-essential chrome (see index.css) so the terminal tail stays visible
 * above the keyboard.
 */
function TerminalComposer({ handle, task, project, dispatch, projectId }: TerminalComposerProps) {
	const t = useT();
	const [text, setText] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [scheduleOpen, setScheduleOpen] = useState(false);
	const [uploading, setUploading] = useState(false);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const focusedViewportHeightRef = useRef<number | null>(null);

	// "Send later" is only reachable here when a live-agent task context exists.
	const canScheduleLater = !!(task && project && dispatch && ACTIVE_STATUSES.includes(task.status) && task.worktreePath);

	// Attachments need a project to resolve the worktree uploads dir.
	const uploadProjectId = projectId ?? project?.id;

	function autogrow() {
		const ta = taRef.current;
		if (!ta) return;
		if (expanded) {
			ta.style.height = "";
			return;
		}
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, MAX_COLLAPSED_HEIGHT_PX)}px`;
	}

	// Re-measure when the text changes (typing or programmatic path insertion)
	// or the expanded state flips (the textarea element persists).
	useEffect(() => {
		autogrow();
		// autogrow reads the latest `expanded` from the closure of this render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text, expanded]);

	// Never leave the chrome collapsed behind after unmount.
	useEffect(() => () => {
		delete document.documentElement.dataset.composerFocused;
	}, []);

	function markFocused(on: boolean) {
		if (on) document.documentElement.dataset.composerFocused = "true";
		else delete document.documentElement.dataset.composerFocused;
	}

	function handleFocus() {
		focusedViewportHeightRef.current = window.visualViewport?.height ?? null;
		markFocused(true);
	}

	function handleBlur() {
		focusedViewportHeightRef.current = null;
		markFocused(false);
	}

	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const activeViewport = viewport as VisualViewport;

		function syncComposerChrome() {
			const textarea = taRef.current;
			if (!textarea || document.activeElement !== textarea) {
				focusedViewportHeightRef.current = null;
				markFocused(false);
				return;
			}

			const focusedHeight = focusedViewportHeightRef.current;
			if (focusedHeight === null || activeViewport.height > focusedHeight) {
				focusedViewportHeightRef.current = activeViewport.height;
				markFocused(true);
				return;
			}

			markFocused(activeViewport.height < focusedHeight - KEYBOARD_VIEWPORT_DELTA_PX);
		}

		activeViewport.addEventListener("resize", syncComposerChrome);
		return () => activeViewport.removeEventListener("resize", syncComposerChrome);
	}, []);

	/** Append uploaded worktree paths to the draft so the user can caption and send. */
	function appendPaths(paths: string[]) {
		if (!paths.length) return;
		const joined = paths.join(" ");
		setText((prev) => {
			if (!prev) return `${joined} `;
			return /[\s\n]$/.test(prev) ? `${prev}${joined} ` : `${prev} ${joined} `;
		});
	}

	/** Upload picked/pasted files into the worktree uploads dir and insert their paths. */
	async function attachFiles(files: File[]) {
		if (!uploadProjectId || files.length === 0) return;
		setUploading(true);
		try {
			const paths = await Promise.all(
				files.map(async (f) => {
					try {
						const uploaded = await uploadDroppedFile(uploadProjectId, f);
						return uploaded ? uploaded.replace(/ /g, "\\ ") : null;
					} catch (err) {
						toast.error(
							t("fileDrop.uploadFailed", { error: String(err instanceof Error ? err.message : err) }),
							{ taskId: task?.id },
						);
						return null;
					}
				}),
			);
			appendPaths(paths.filter((p): p is string => Boolean(p)));
		} finally {
			setUploading(false);
		}
	}

	function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
		const files = Array.from(e.target.files ?? []);
		// Reset so picking the same file again re-fires onChange.
		e.target.value = "";
		void attachFiles(files);
	}

	// Phone clipboards deliver screenshots as files on the paste event — the
	// desktop interceptor in TerminalView never sees composer pastes, so handle
	// them here. Plain-text pastes keep the default textarea behavior.
	function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
		const files = Array.from(e.clipboardData?.files ?? []);
		if (!files.length || !uploadProjectId) return;
		e.preventDefault();
		void attachFiles(files);
	}

	function deliver(submit: boolean) {
		if (!text) return;
		if (submit) handle.submit(text);
		else handle.paste(text);
		setText("");
		setExpanded(false);
		requestAnimationFrame(() => {
			const ta = taRef.current;
			if (!ta) return;
			ta.style.height = "auto";
		});
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		// Hardware keyboards: Ctrl/Cmd+Enter sends; plain Enter stays a newline.
		if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
			e.preventDefault();
			deliver(true);
		}
	}

	// preventDefault on mousedown keeps the textarea focused (and the OSK open)
	// while tapping composer buttons — same discipline as ExtraKeyBar.
	const keepFocus = (e: React.MouseEvent) => e.preventDefault();

	const iconBtn =
		"flex-shrink-0 flex items-center justify-center rounded-lg h-11 w-11 select-none active:opacity-70 transition-opacity";

	const buttons = (
		<>
			{uploadProjectId && (
				<>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						className="hidden"
						onChange={onFilesPicked}
						data-testid="terminal-composer-file-input"
					/>
					{/* order-first pulls the paperclip left of the textarea in the
					    collapsed bar (messenger convention); in the expanded editor the
					    buttons row is a separate flex container where it is first anyway. */}
					<button
						type="button"
						className={`${iconBtn} order-first bg-elevated text-fg-2 disabled:opacity-40`}
						onMouseDown={keepFocus}
						onClick={() => fileInputRef.current?.click()}
						disabled={uploading}
						aria-label={t("terminal.composerAttach")}
						title={t("terminal.composerAttach")}
					>
						{uploading ? (
							<div className="w-4 h-4 border-2 border-fg-muted/30 border-t-accent rounded-full animate-spin" />
						) : (
							<span className="text-[1.125rem] leading-none" style={{ fontFamily: NERD_FONT }}>
								{"\u{F03E2}"}
							</span>
						)}
					</button>
				</>
			)}
			<button
				type="button"
				className={`${iconBtn} bg-elevated text-fg-2`}
				onMouseDown={keepFocus}
				onClick={() => setExpanded((v) => !v)}
				aria-label={expanded ? t("terminal.composerCollapse") : t("terminal.composerExpand")}
				title={expanded ? t("terminal.composerCollapse") : t("terminal.composerExpand")}
			>
				<span className="text-[1.125rem] leading-none" style={{ fontFamily: NERD_FONT }}>
					{expanded ? "\u{F0294}" : "\u{F0293}"}
				</span>
			</button>
			{canScheduleLater && (
				<button
					type="button"
					className={`${iconBtn} bg-elevated text-fg-2 disabled:opacity-40`}
					onMouseDown={keepFocus}
					onClick={() => setScheduleOpen(true)}
					disabled={!text}
					aria-label={t("terminal.composerScheduleLater")}
					title={t("terminal.composerScheduleLater")}
				>
					<span className="text-[1.125rem] leading-none" style={{ fontFamily: NERD_FONT }}>
						{"\u{F0954}"}
					</span>
				</button>
			)}
			<button
				type="button"
				className={`${iconBtn} bg-elevated text-fg-2 disabled:opacity-40`}
				onMouseDown={keepFocus}
				onClick={() => deliver(false)}
				disabled={!text}
				aria-label={t("terminal.composerInsert")}
				title={t("terminal.composerInsert")}
			>
				<span className="text-[1.125rem] leading-none" style={{ fontFamily: NERD_FONT }}>
					{"\u{F0192}"}
				</span>
			</button>
			<button
				type="button"
				className={`${iconBtn} bg-accent text-white disabled:opacity-40`}
				onMouseDown={keepFocus}
				onClick={() => deliver(true)}
				disabled={!text}
				aria-label={t("terminal.composerSend")}
				title={t("terminal.composerSend")}
			>
				<span className="text-[1.125rem] leading-none" style={{ fontFamily: NERD_FONT }}>
					{"\u{F048A}"}
				</span>
			</button>
		</>
	);

	const textarea = (
		<textarea
			ref={taRef}
			value={text}
			onChange={(e) => {
				setText(e.target.value);
				autogrow();
			}}
			onKeyDown={onKeyDown}
			onPaste={onPaste}
			onFocus={handleFocus}
			onBlur={handleBlur}
			placeholder={t("terminal.composerPlaceholder")}
			rows={1}
			autoCapitalize="off"
			autoCorrect="on"
			spellCheck={false}
			className={`flex-1 min-w-0 resize-none rounded-lg bg-elevated text-fg text-base leading-snug px-3 py-2.5 border border-edge focus:border-accent outline-none placeholder:text-fg-muted ${expanded ? "min-h-0 h-full" : "min-h-[2.75rem]"}`}
			data-testid="terminal-composer-input"
		/>
	);

	// ONE tree for both states — only classNames flip. A separate JSX branch
	// would remount the textarea on expand, dropping focus and closing the OSK.
	// Collapsed: a docked bar (buttons are flex items via display:contents).
	// Expanded: a full-surface editor overlaying the terminal area.
	return (
		<div
			className={
				expanded
					? "absolute inset-0 z-30 bg-base flex flex-col gap-2 p-2"
					: "flex-shrink-0 flex items-end gap-2 px-2 py-1.5 bg-base border-t border-edge"
			}
			data-testid="terminal-composer"
		>
			{textarea}
			<div className={expanded ? "flex flex-shrink-0 items-center justify-end gap-2" : "contents"}>{buttons}</div>
			{scheduleOpen && task && project && dispatch && createPortal(
				<ScheduleMessageModal
					task={task}
					project={project}
					dispatch={dispatch}
					initialText={text}
					onClose={() => setScheduleOpen(false)}
				/>,
				document.body,
			)}
		</div>
	);
}

export default TerminalComposer;
