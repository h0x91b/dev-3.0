import { useState, useRef, useEffect } from "react";
import { api } from "../rpc";
import { trackEvent } from "../analytics";
import { useT } from "../i18n";
import type { Dispatch } from "react";
import type { AppAction } from "../state";

interface InlineRenameProps {
	taskId: string;
	projectId: string;
	currentTitle: string;
	hasCustomTitle?: boolean;
	/** If provided, dispatches updateTask after save. Otherwise relies on pushMessage. */
	dispatch?: Dispatch<AppAction>;
	/** Additional CSS class for the display text */
	className?: string;
	/** CSS class for the input field */
	inputClassName?: string;
	/** Show "Reset to auto" link when editing a custom title */
	showReset?: boolean;
}

export default function InlineRename({
	taskId,
	projectId,
	currentTitle,
	hasCustomTitle,
	dispatch,
	className = "text-fg font-semibold truncate",
	inputClassName = "bg-base border border-edge-active rounded px-1.5 py-0.5 text-sm text-fg font-semibold focus:outline-none focus:border-accent",
	showReset,
}: InlineRenameProps) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const wrapperRef = useRef<HTMLSpanElement>(null);
	const savingRef = useRef(false);

	function startEditing() {
		setValue(currentTitle);
		setEditing(true);
	}

	async function save(customTitle: string | null) {
		if (savingRef.current) return;
		const trimmed = customTitle?.trim() || null;
		if (customTitle !== null && (!trimmed || trimmed === currentTitle)) {
			setEditing(false);
			return;
		}
		savingRef.current = true;
		setSaving(true);
		try {
			const updated = await api.request.renameTask({ taskId, projectId, customTitle: trimmed });
			if (dispatch) dispatch({ type: "updateTask", task: updated });
			trackEvent("task_renamed", { project_id: projectId });
			setEditing(false);
		} catch (err) {
			alert(t("task.failedRename", { error: String(err) }));
		}
		setSaving(false);
		savingRef.current = false;
	}

	// Click outside → save; no onBlur needed (avoids race with Escape)
	useEffect(() => {
		if (!editing) return;
		function handleMouseDown(e: MouseEvent) {
			if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
				save(value);
			}
		}
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	});

	// Reset editing state when task changes
	useEffect(() => setEditing(false), [taskId]);

	if (editing) {
		return (
			<span ref={wrapperRef} className="flex items-center gap-0.5 min-w-0">
				<input
					ref={inputRef}
					type="text"
					autoFocus
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") save(value);
						if (e.key === "Escape") { e.stopPropagation(); setEditing(false); }
					}}
					disabled={saving}
					className={inputClassName}
				/>
				<button
					onClick={() => save(value)}
					disabled={saving}
					className="flex-shrink-0 p-0.5 rounded hover:bg-elevated transition-colors text-green-400 hover:text-green-300"
					title={t("task.rename")}
					data-testid="rename-save"
				>
					<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
					</svg>
				</button>
				<button
					onClick={() => setEditing(false)}
					disabled={saving}
					className="flex-shrink-0 p-0.5 rounded hover:bg-elevated transition-colors text-danger hover:text-red-400"
					title={t("task.cancel")}
					data-testid="rename-cancel"
				>
					<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
				{showReset && hasCustomTitle && (
					<button
						onClick={() => save(null)}
						disabled={saving}
						className="text-[0.625rem] text-fg-3 hover:text-fg-2 transition-colors flex-shrink-0 whitespace-nowrap"
					>
						{t("task.resetTitle")}
					</button>
				)}
			</span>
		);
	}

	return (
		<span className="flex items-center gap-1 min-w-0 group/rename">
			<span className={className}>{currentTitle}</span>
			<button
				onClick={startEditing}
				className="flex-shrink-0 p-0.5 rounded hover:bg-elevated transition-colors text-fg-muted opacity-0 group-hover/rename:opacity-100"
				title={t("task.renameTitle")}
			>
				<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
				</svg>
			</button>
		</span>
	);
}
