import { useState, useCallback, useRef } from "react";
import { api } from "../rpc";

export function useFileDrop(
	onFileDropped: (path: string) => void,
): {
	handleDragOver: (e: React.DragEvent) => void;
	handleDragEnter: (e: React.DragEvent) => void;
	handleDragLeave: (e: React.DragEvent) => void;
	handleDrop: (e: React.DragEvent) => void;
	isDragging: boolean;
} {
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
			const files = e.dataTransfer.files;
			if (!files.length) return;

			const promises: Promise<void>[] = [];
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				promises.push(
					api.request.resolveFilename({
						filename: file.name,
						size: file.size,
						lastModified: file.lastModified,
					}).then((resolvedPath) => {
						if (resolvedPath) {
							onFileDropped(resolvedPath);
						}
					}).catch(() => {}),
				);
			}

			Promise.all(promises);
		},
		[onFileDropped],
	);

	return { handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging };
}
