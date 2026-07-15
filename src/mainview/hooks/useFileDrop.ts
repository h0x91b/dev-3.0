import { useState, useCallback, useRef } from "react";
import { useT } from "../i18n";
import { toast } from "../toast";
import { uploadDroppedFile } from "../utils/uploadDroppedFile";

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

			void Promise.all(files.map(async (file) => {
				try {
					const uploadedPath = await uploadDroppedFile(projectId, file);
					if (uploadedPath) {
						onFileDropped(uploadedPath);
					}
				} catch (err) {
					console.error(`[useFileDrop] file upload failed for "${file.name}":`, err);
					toast.error(t("fileDrop.uploadFailed", { error: String(err instanceof Error ? err.message : err) }), { taskId });
				}
			}));
		},
		[onFileDropped, projectId, taskId, t],
	);

	return { handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging };
}
