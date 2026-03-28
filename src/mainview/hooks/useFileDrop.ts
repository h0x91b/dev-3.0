import { useState, useCallback, useRef } from "react";
import { api } from "../rpc";

async function fileToBase64(file: File): Promise<string> {
	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	const chunks: string[] = [];
	const CHUNK_SIZE = 0x8000;

	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)));
	}

	return btoa(chunks.join(""));
}

export function useFileDrop(
	projectId: string,
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
			const files = Array.from(e.dataTransfer.files);
			if (!files.length) return;

			void Promise.all(files.map(async (file) => {
				if (projectId && file.type.startsWith("image/")) {
					try {
						const base64 = await fileToBase64(file);
						const uploaded = await api.request.uploadImageBase64({
							projectId,
							base64,
							filename: file.name,
							mimeType: file.type || undefined,
						});
						if (uploaded?.path) {
							onFileDropped(uploaded.path);
							return;
						}
					} catch (err) {
						console.error(`[useFileDrop] image upload failed for "${file.name}":`, err);
					}
				}

				try {
					const resolvedPath = await api.request.resolveFilename({
						filename: file.name,
						size: file.size,
						lastModified: file.lastModified,
					});
					if (resolvedPath) {
						onFileDropped(resolvedPath);
					}
				} catch (err) {
					console.error(`[useFileDrop] resolveFilename failed for "${file.name}":`, err);
				}
			}));
		},
		[onFileDropped, projectId],
	);

	return { handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging };
}
