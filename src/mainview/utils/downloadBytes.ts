/**
 * Anchor-click download from renderer-owned bytes. Electrobun lands these in
 * ~/Downloads and a remote browser uses its own download dir — unlike the native
 * WKWebView "Save Image As…", which silently does nothing or writes to an opaque
 * cache path (decision 2026/07/21 artifact-image-save-via-parent).
 */
export function downloadBase64(base64: string, mime: string, fileName: string): void {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function parseDataUrl(src: string): { mime: string; base64: string } | null {
	const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src);
	if (!match) return null;
	const mime = match[1] || "application/octet-stream";
	if (match[2]) return { mime, base64: match[3] };
	try {
		return { mime, base64: btoa(decodeURIComponent(match[3])) };
	} catch {
		return null;
	}
}

/** Download a `data:` URL under `fileName`. Throws if the URL is not parseable. */
export function downloadDataUrl(dataUrl: string, fileName: string): void {
	const parsed = parseDataUrl(dataUrl);
	if (!parsed) throw new Error("unparseable data URL");
	downloadBase64(parsed.base64, parsed.mime, fileName);
}
