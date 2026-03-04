import { useState, useEffect, useRef, useCallback } from "react";
import type { TaskNote } from "../../shared/types";
import { useT } from "../i18n";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { ImageAttachmentsStrip } from "./ImageAttachmentsStrip";
import { useImagePaste } from "../hooks/useImagePaste";
import { useFileDrop } from "../hooks/useFileDrop";

export function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

interface NoteItemProps {
	note: TaskNote;
	onSave: (content: string) => void;
	onDelete: () => void;
	projectId?: string;
}

export function NoteItem({ note, onSave, onDelete, projectId }: NoteItemProps) {
	const t = useT();
	const [value, setValue] = useState(note.content);
	const isAi = note.source === "ai";
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const insertPath = useCallback((path: string) => {
		const el = textareaRef.current;
		if (!el) {
			const next = value + (value && !value.endsWith("\n") ? "\n" : "") + path + "\n";
			setValue(next);
			onSave(next);
			return;
		}
		const start = el.selectionStart;
		const end = el.selectionEnd;
		const prefix = start > 0 && el.value[start - 1] !== "\n" ? "\n" : "";
		const insert = prefix + path + "\n";
		const next = el.value.slice(0, start) + insert + el.value.slice(end);
		setValue(next);
		onSave(next);
		requestAnimationFrame(() => {
			const pos = start + insert.length;
			el.selectionStart = pos;
			el.selectionEnd = pos;
			el.focus();
		});
	}, [value, onSave]);

	const { handlePaste, isPasting } = useImagePaste(projectId ?? "", insertPath);
	const { handleDragOver, handleDrop } = useFileDrop(insertPath);

	const debouncedSave = useDebouncedCallback((content: string) => {
		onSave(content);
	}, 800);

	function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
		const newValue = e.target.value;
		setValue(newValue);
		debouncedSave(newValue);
	}

	// Sync local value when note updates from outside (e.g. after save returns)
	useEffect(() => {
		setValue(note.content);
	}, [note.id]);

	return (
		<div className="mb-2 rounded-lg bg-base border border-edge p-2 group">
			<div className="flex items-center justify-between mb-1">
				<span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
					isAi ? "bg-accent/10 text-accent" : "bg-raised text-fg-3"
				}`}>
					{isAi ? t("notes.sourceAi") : t("notes.sourceUser")}
				</span>
				<div className="flex items-center gap-1.5">
					<span className="text-[10px] text-fg-muted">{formatDate(note.updatedAt)}</span>
					<button
						onClick={onDelete}
						className="opacity-0 group-hover:opacity-100 text-fg-muted hover:text-danger transition-opacity p-0.5"
						title={t("notes.delete")}
					>
						<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
			</div>
			{isAi ? (
				<>
					<div className="text-xs text-fg-2 whitespace-pre-wrap">{note.content}</div>
					<ImageAttachmentsStrip text={note.content} />
				</>
			) : (
				<>
					<textarea
						ref={textareaRef}
						value={value}
						onChange={handleChange}
						onPaste={projectId ? handlePaste : undefined}
						onDragOver={projectId ? handleDragOver : undefined}
						onDrop={projectId ? handleDrop : undefined}
						className="w-full bg-transparent text-xs text-fg-2 resize-none outline-none min-h-[40px]"
						placeholder={t("notes.placeholder")}
						autoFocus={note.content === ""}
					/>
					{isPasting && (
						<span className="text-[10px] text-accent animate-pulse">{t("images.pasting")}</span>
					)}
					<ImageAttachmentsStrip text={value} />
				</>
			)}
		</div>
	);
}
