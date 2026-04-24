import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TerminalPreviewState } from "../hooks/useTerminalPreview";
import { api } from "../rpc";
import { useT } from "../i18n";

const OVERVIEW_MAX_LEN = 500;
const FALLBACK_DESCRIPTION_CHARS = 240;
const EDIT_ICON = "\u{F040}"; // nf-mdi-pencil
const SAVE_ICON = "\u{F00C}"; // nf-fa-check
const CANCEL_ICON = "\u{F00D}"; // nf-fa-times
const REVERT_ICON = "\u{F0450}"; // nf-md-undo_variant

interface TerminalPreviewPopoverProps extends TerminalPreviewState {
	/** Full task id (resolved by consumer from activeTaskId). */
	taskId?: string | null;
	projectId?: string | null;
	/** Agent-written overview (read-only for UI display/edit purposes). */
	overview?: string | null;
	/** User-edited override. When present, takes precedence over `overview`. */
	userOverview?: string | null;
	description?: string | null;
}

function truncate(text: string, maxLen: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= maxLen) return clean;
	return clean.slice(0, maxLen - 1) + "…";
}

function TerminalPreviewPopover({
	open,
	html,
	loading,
	pos,
	cancelClose,
	scheduleClose,
	taskId,
	projectId,
	overview,
	userOverview,
	description,
}: TerminalPreviewPopoverProps) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	// Reset editor whenever the popover switches to a different task or closes.
	useEffect(() => {
		setEditing(false);
		setValue("");
		setSaving(false);
	}, [taskId, open]);

	// The effective overview shown everywhere: the user edit wins if present.
	const aiOverview = overview?.trim() || "";
	const userEdit = userOverview?.trim() || "";
	const effectiveOverview = userEdit || aiOverview;
	const hasUserOverride = userEdit.length > 0;

	const startEditing = useCallback(() => {
		if (!taskId || !projectId) return;
		// Prefill with whatever is currently shown — user edit if present,
		// otherwise the AI version so the user can tweak instead of starting blank.
		setValue(effectiveOverview);
		setEditing(true);
		cancelClose();
		// Keep popover anchored while the textarea is focused.
		setTimeout(() => textareaRef.current?.focus(), 0);
	}, [taskId, projectId, effectiveOverview, cancelClose]);

	const cancelEditing = useCallback(() => {
		setEditing(false);
		setValue("");
	}, []);

	const save = useCallback(async () => {
		if (!taskId || !projectId) return;
		const trimmed = value.trim();
		if (trimmed.length > OVERVIEW_MAX_LEN) return;
		// Saving the same text that's already shown — no-op.
		if (trimmed === effectiveOverview) {
			setEditing(false);
			return;
		}
		setSaving(true);
		try {
			if (!trimmed || trimmed === aiOverview) {
				// Empty save or user typed exactly the AI version — drop the
				// override so the agent's overview is shown again.
				await api.request.clearUserOverview({ taskId, projectId });
			} else {
				await api.request.setUserOverview({
					taskId,
					projectId,
					userOverview: trimmed,
				});
			}
			setEditing(false);
		} catch (err) {
			alert(t("overview.saveFailed", { error: String(err) }));
		}
		setSaving(false);
	}, [taskId, projectId, value, effectiveOverview, aiOverview, t]);

	const revertToAI = useCallback(async () => {
		if (!taskId || !projectId) return;
		setSaving(true);
		try {
			await api.request.clearUserOverview({ taskId, projectId });
			setEditing(false);
			setValue("");
		} catch (err) {
			alert(t("overview.saveFailed", { error: String(err) }));
		}
		setSaving(false);
	}, [taskId, projectId, t]);

	if (!open) return null;

	const hasOverview = effectiveOverview.length > 0;
	const hasDescription = !!(description && description.trim());
	const canEdit = !!taskId && !!projectId;
	const showOverviewBlock = hasOverview || hasDescription || editing;

	const overBudget = value.length > OVERVIEW_MAX_LEN;

	const displayText = hasOverview
		? effectiveOverview
		: hasDescription
			? truncate(description!, FALLBACK_DESCRIPTION_CHARS)
			: "";

	const labelKey = hasOverview ? "overview.label" : "overview.labelFallback";

	return createPortal(
		<div
			ref={wrapperRef}
			className="fixed z-50 rounded-xl shadow-2xl shadow-black/50 border border-edge-active overflow-hidden transition-opacity duration-150 bg-overlay flex flex-col"
			style={{
				top: pos.top,
				left: pos.left,
				width: 420,
				maxHeight: editing ? 520 : 420,
				opacity: html || loading || showOverviewBlock ? 1 : 0,
			}}
			onMouseEnter={cancelClose}
			onMouseLeave={() => { if (!editing) scheduleClose(); }}
			onClick={(e) => e.stopPropagation()}
		>
			{showOverviewBlock && (
				<div className="flex flex-col border-b border-edge p-2 gap-1">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-1.5 min-w-0">
							<span
								className={`text-[0.5625rem] font-semibold uppercase tracking-wider ${
									hasOverview ? "text-fg-3" : "text-fg-muted"
								}`}
							>
								{t(labelKey)}
							</span>
							{hasUserOverride && (
								<span
									className="text-[0.5625rem] text-fg-muted italic"
									title={t("overview.editedByYouHint")}
								>
									{t("overview.editedByYou")}
								</span>
							)}
						</div>
						<div className="flex items-center gap-2">
							{canEdit && !editing && hasUserOverride && (
								<button
									type="button"
									onClick={() => void revertToAI()}
									disabled={saving}
									className="flex-shrink-0 text-fg-muted hover:text-accent transition-colors leading-none disabled:opacity-40"
									title={t("overview.revertToAI")}
									aria-label={t("overview.revertToAI")}
								>
									<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'", fontSize: "0.875rem" }}>
										{REVERT_ICON}
									</span>
								</button>
							)}
							{canEdit && !editing && (
								<button
									type="button"
									onClick={startEditing}
									className="flex-shrink-0 text-fg-muted hover:text-fg-2 transition-colors leading-none"
									title={t("overview.edit")}
									aria-label={t("overview.edit")}
								>
									<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'", fontSize: "0.875rem" }}>
										{EDIT_ICON}
									</span>
								</button>
							)}
						</div>
					</div>
					{editing ? (
						<>
							<textarea
								ref={textareaRef}
								value={value}
								onChange={(e) => setValue(e.target.value)}
								onFocus={cancelClose}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.stopPropagation();
										cancelEditing();
									} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
										e.preventDefault();
										void save();
									}
								}}
								rows={5}
								disabled={saving}
								placeholder={t("overview.editPlaceholder")}
								className="w-full resize-none bg-base border border-edge-active rounded px-2 py-1.5 text-[0.75rem] leading-snug text-fg focus:outline-none focus:border-accent"
							/>
							<div className="flex items-center justify-between gap-2">
								<span
									className={`text-[0.5625rem] font-mono ${
										overBudget ? "text-danger" : "text-fg-muted"
									}`}
								>
									{value.length}/{OVERVIEW_MAX_LEN}
								</span>
								<div className="flex items-center gap-2">
									<span className="text-[0.5625rem] text-fg-muted">
										{t("overview.saveHint")}
									</span>
									<button
										type="button"
										onClick={cancelEditing}
										disabled={saving}
										className="flex-shrink-0 text-fg-muted hover:text-danger transition-colors leading-none"
										title={t("overview.cancel")}
										aria-label={t("overview.cancel")}
									>
										<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'", fontSize: "0.875rem" }}>
											{CANCEL_ICON}
										</span>
									</button>
									<button
										type="button"
										onClick={() => void save()}
										disabled={saving || overBudget || !value.trim() && !hasOverview}
										className="flex-shrink-0 text-fg-muted hover:text-accent transition-colors leading-none disabled:opacity-40 disabled:hover:text-fg-muted"
										title={t("overview.save")}
										aria-label={t("overview.save")}
									>
										<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'", fontSize: "0.875rem" }}>
											{SAVE_ICON}
										</span>
									</button>
								</div>
							</div>
						</>
					) : (
						<p
							className={`text-[0.75rem] leading-snug whitespace-pre-wrap break-words ${
								hasOverview ? "text-fg-2" : "text-fg-3 italic"
							}`}
							style={{
								display: "-webkit-box",
								WebkitLineClamp: 6,
								WebkitBoxOrient: "vertical",
								overflow: "hidden",
							}}
						>
							{displayText || t("overview.empty")}
						</p>
					)}
				</div>
			)}

			<div className="flex-1 min-h-0 overflow-hidden">
				{loading ? (
					<div className="flex items-center justify-center h-20">
						<div className="w-4 h-4 border-2 border-fg-muted/30 border-t-fg-muted rounded-full animate-spin" />
					</div>
				) : html ? (
					<pre
						className="overflow-hidden m-0 p-2"
						style={{
							fontFamily: "monospace",
							fontSize: "5px",
							lineHeight: "6px",
							color: "#d3d7cf",
							whiteSpace: "pre",
							userSelect: "none",
						}}
						dangerouslySetInnerHTML={{ __html: html }}
					/>
				) : null}
			</div>
		</div>,
		document.body,
	);
}

export default TerminalPreviewPopover;
