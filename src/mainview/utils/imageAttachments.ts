const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/**
 * Match absolute paths ending in an image extension.
 * Works both on their own line and inline within text.
 * Paths may contain spaces (e.g. "/Users/foo/Screenshot 2026-03-04.png").
 * The path ends at the image extension boundary.
 */
const IMAGE_PATH_RE = /(\/(?:[^\n"'<>]*\/)*[^\n"'<>]+\.(png|jpe?g|gif|webp|bmp|svg))/gi;

/**
 * Match non-image attachment paths we generate under the worktree uploads dir.
 * Scoped to `/uploads/upload-<ts>-<hex>-<name>.<ext>` so plain file paths
 * mentioned in prose (e.g. `/Users/me/src/foo.ts`) don't render as chips.
 */
const UPLOAD_FILE_PATH_RE = /(\/[^\n"'<>]*\/uploads\/upload-\d+-[0-9a-f]{4}-[^\n"'<>]+\.[A-Za-z0-9]{1,16})/gi;

/**
 * Extract absolute image paths from text.
 * Returns a deduplicated array of paths.
 */
export function extractImagePaths(text: string): string[] {
	if (!text) return [];
	const results: string[] = [];
	let match: RegExpExecArray | null;
	IMAGE_PATH_RE.lastIndex = 0;
	while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
		results.push(match[1]);
	}
	return [...new Set(results)];
}

/**
 * Extract non-image uploaded file paths (e.g. pasted-text.txt) from text.
 * Returns a deduplicated array of paths.
 */
export function extractFilePaths(text: string): string[] {
	if (!text) return [];
	const results: string[] = [];
	let match: RegExpExecArray | null;
	UPLOAD_FILE_PATH_RE.lastIndex = 0;
	while ((match = UPLOAD_FILE_PATH_RE.exec(text)) !== null) {
		if (!isImagePath(match[1])) results.push(match[1]);
	}
	return [...new Set(results)];
}

/** Remove an image path from text (handles both whole-line and inline). */
export function removeImagePath(text: string, pathToRemove: string): string {
	// First try removing as a whole line
	const lines = text.split("\n");
	const filtered = lines.filter((line) => line.trim() !== pathToRemove);
	if (filtered.length < lines.length) {
		return filtered.join("\n").replace(/\n{3,}/g, "\n\n");
	}
	// Otherwise remove inline occurrence
	return text.replaceAll(pathToRemove, "").replace(/  +/g, " ").replace(/\n{3,}/g, "\n\n");
}

/** Check if a file path ends with a known image extension. */
export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.test(path);
}
