import { useState, useCallback, useRef } from "react";
import { useT } from "../i18n";
import { toast } from "../toast";
import { dropEntryError, paneShellDialect, placeDroppedFiles, quotePath } from "../utils/droppedFiles";

export function useFileDrop(
	projectId: string,
	onFileDropped: (path: string) => void,
	taskId?: string,
): {
	handleDragOver: (e: React.DragEvent) => void;
	handleDragEnter: (e: React.DragEvent) => void;
	handleDragLeave: (e: React.DragEvent) => void;
	handleDrop: (e: React.DragEvent) => void;
	isDragging: boolean;
} {
	const t = useT();
	const [isDragging, setIsDragging] = useState(false);
	const dragCounter = useRef(0);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	}, []);

	const handleDragEnter = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		dragCounter.current++;
		setIsDragging(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		dragCounter.current--;
		if (dragCounter.current <= 0) {
			dragCounter.current = 0;
			setIsDragging(false);
		}
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			dragCounter.current = 0;
			setIsDragging(false);
			const files = Array.from(e.dataTransfer.files);
			if (!files.length) return;

			// Native file drops can blur the editor before this event arrives. Restore
			// focus before the asynchronous upload so the composer stays ready for the
			// next keystroke while the attachment is being saved.
			const dropZone = e.currentTarget as HTMLElement;
			const editor = dropZone.matches("textarea, input, [contenteditable='true']")
				? dropZone
				: dropZone.querySelector<HTMLElement>("textarea, input, [contenteditable='true']");
			editor?.focus();

			void placeDroppedFiles(projectId, files).then((entries) => {
				const inserted: string[] = [];
				for (const entry of entries) {
					// A host path is the file's original, not a copy: quoted, it reads as one path.
					if (entry.kind === "uploaded") inserted.push(entry.path);
					else if (entry.kind === "host") inserted.push(quotePath(entry.path, paneShellDialect()));
					const error = dropEntryError(entry, t);
					if (error) {
						console.error(`[useFileDrop] dropped file not uploaded (${entry.kind})`);
						toast.error(error, { taskId });
					}
				}
				// One insert: back-to-back inserts all read the same stale caret and land reversed.
				if (inserted.length > 0) onFileDropped(inserted.join("\n"));
			});
		},
		[onFileDropped, projectId, taskId, t],
	);

	return { handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging };
}
