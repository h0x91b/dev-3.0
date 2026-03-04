import { useState, useCallback } from "react";
import { api } from "../rpc";

export function useFileDrop(
	onFileDropped: (path: string) => void,
): { handleDragOver: (e: React.DragEvent) => void; handleDrop: (e: React.DragEvent) => void; isDropping: boolean } {
	const [isDropping, setIsDropping] = useState(false);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			const files = e.dataTransfer.files;
			if (!files.length) return;

			setIsDropping(true);

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

			Promise.all(promises).finally(() => {
				setIsDropping(false);
			});
		},
		[onFileDropped],
	);

	return { handleDragOver, handleDrop, isDropping };
}
