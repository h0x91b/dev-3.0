import { useState, useEffect } from "react";
import type { TaskNote } from "../../shared/types";
import { useT } from "../i18n";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";

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
}

export function NoteItem({ note, onSave, onDelete }: NoteItemProps) {
	const t = useT();
	const [value, setValue] = useState(note.content);
	const isAi = note.source === "ai";

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
				<div className="text-xs text-fg-2 whitespace-pre-wrap">{note.content}</div>
			) : (
				<textarea
					value={value}
					onChange={handleChange}
					className="w-full bg-transparent text-xs text-fg-2 resize-none outline-none min-h-[40px]"
					placeholder={t("notes.placeholder")}
					autoFocus={note.content === ""}
				/>
			)}
		</div>
	);
}
