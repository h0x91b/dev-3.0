/**
 * Image files carried by a paste event itself.
 *
 * Prefer these over reading the host clipboard through the bun process: the
 * webview already decoded the clipboard bitmap into real PNG bytes, it is the
 * user's own device in remote mode, and it needs no platform-specific handling.
 *
 * `files` is checked first and `items` only as a fallback, because a webview
 * that populates both describes the SAME image twice — uploading from both
 * would attach it twice.
 */
export function imageFilesFromClipboard(clip: DataTransfer | null | undefined): File[] {
	if (!clip) return [];

	const fromFiles = Array.from(clip.files ?? []).filter((f) => f.type.startsWith("image/"));
	if (fromFiles.length > 0) return fromFiles;

	const items = clip.items;
	if (!items) return [];
	const fromItems: File[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		// A synthetic paste event (and some webviews) expose items without getAsFile.
		if (!item || item.kind !== "file" || !item.type.startsWith("image/")) continue;
		if (typeof item.getAsFile !== "function") continue;
		const file = item.getAsFile();
		if (file) fromItems.push(file);
	}
	return fromItems;
}
