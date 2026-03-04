const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/**
 * Match absolute paths ending in an image extension.
 * Works both on their own line and inline within text.
 * Paths may contain spaces (e.g. "/Users/foo/Screenshot 2026-03-04.png").
 * The path ends at the image extension boundary.
 */
const IMAGE_PATH_RE = /(\/(?:[^\n"'<>]*\/)*[^\n"'<>]+\.(png|jpe?g|gif|webp|bmp|svg))/gi;

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
