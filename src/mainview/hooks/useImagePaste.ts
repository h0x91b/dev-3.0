import { useState, useCallback, useEffect, useRef } from "react";
import { api } from "../rpc";

export function useImagePaste(
	projectId: string,
	onImagePasted: (path: string) => void,
): { handlePaste: (e: React.ClipboardEvent) => void; isPasting: boolean } {
	const [isPasting, setIsPasting] = useState(false);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => { mountedRef.current = false; };
	}, []);

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
				if (!mountedRef.current) return;
				if (result) {
					onImagePasted(result.path);
				}
				setIsPasting(false);
			}).catch(() => {
				if (!mountedRef.current) return;
				setIsPasting(false);
			});
		},
		[projectId, onImagePasted],
	);

	return { handlePaste, isPasting };
}
