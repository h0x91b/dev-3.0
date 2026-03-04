import { useState, useCallback } from "react";
import { api } from "../rpc";

export function useImagePaste(
	projectId: string,
	onImagePasted: (path: string) => void,
): { handlePaste: (e: React.ClipboardEvent) => void; isPasting: boolean } {
	const [isPasting, setIsPasting] = useState(false);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items) return;

			let hasImage = false;
			for (let i = 0; i < items.length; i++) {
				if (items[i].type.startsWith("image/")) {
					hasImage = true;
					break;
				}
			}

			if (!hasImage) return;

			e.preventDefault();
			setIsPasting(true);

			api.request.pasteClipboardImage({ projectId }).then((result) => {
				if (result) {
					onImagePasted(result.path);
				}
				setIsPasting(false);
			}).catch(() => {
				setIsPasting(false);
			});
		},
		[projectId, onImagePasted],
	);

	return { handlePaste, isPasting };
}
