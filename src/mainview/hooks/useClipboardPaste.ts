import { useState, useCallback, useEffect, useRef } from "react";
import { api } from "../rpc";
import { isLargeTextPaste, uploadPastedText } from "../utils/uploadPastedText";

type PasteKind = "image" | "text" | null;

export function useClipboardPaste(
	projectId: string,
	onPathPasted: (path: string) => void,
): { handlePaste: (e: React.ClipboardEvent) => void; isPasting: boolean; pasteKind: PasteKind } {
	const [isPasting, setIsPasting] = useState(false);
	const [pasteKind, setPasteKind] = useState<PasteKind>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => { mountedRef.current = false; };
	}, []);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const items = e.clipboardData?.items;

			let hasImage = false;
			if (items) {
				for (let i = 0; i < items.length; i++) {
					if (items[i].type.startsWith("image/")) {
						hasImage = true;
						break;
					}
				}
			}

			if (hasImage) {
				e.preventDefault();
				setIsPasting(true);
				setPasteKind("image");

				api.request.pasteClipboardImage({ projectId }).then((result) => {
					if (!mountedRef.current) return;
					if (result) {
						onPathPasted(result.path);
					}
					setIsPasting(false);
					setPasteKind(null);
				}).catch(() => {
					if (!mountedRef.current) return;
					setIsPasting(false);
					setPasteKind(null);
				});
				return;
			}

			// Large text paste → save to a .txt file instead of dumping raw text.
			const text = e.clipboardData?.getData("text/plain") ?? "";
			if (!projectId || !isLargeTextPaste(text)) return;

			e.preventDefault();
			setIsPasting(true);
			setPasteKind("text");

			uploadPastedText(projectId, text).then((path) => {
				if (!mountedRef.current) return;
				if (path) {
					onPathPasted(path);
				}
				setIsPasting(false);
				setPasteKind(null);
			}).catch(() => {
				if (!mountedRef.current) return;
				setIsPasting(false);
				setPasteKind(null);
			});
		},
		[projectId, onPathPasted],
	);

	return { handlePaste, isPasting, pasteKind };
}
