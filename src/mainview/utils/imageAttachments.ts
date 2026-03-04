const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/**
 * Match lines that are just an absolute path ending in an image extension.
 * Handles paths with spaces (e.g. "/Users/foo/Screenshot 2026-03-04.png").
 */
const IMAGE_LINE_RE = /^(\/[^\n]+\.(png|jpe?g|gif|webp|bmp|svg))$/gim;

/**
 * Extract absolute image paths from text.
 * Paths must be on their own line (inserted by paste/drop or typed manually).
 * Returns a deduplicated array of paths.
 */
export function extractImagePaths(text: string): string[] {
	if (!text) return [];
	const results: string[] = [];
	let match: RegExpExecArray | null;
	IMAGE_LINE_RE.lastIndex = 0;
	while ((match = IMAGE_LINE_RE.exec(text)) !== null) {
		results.push(match[1]);
	}
	return [...new Set(results)];
}

/** Remove an image path line from text. */
export function removeImagePath(text: string, pathToRemove: string): string {
	return text
		.split("\n")
		.filter((line) => line.trim() !== pathToRemove)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

/** Check if a file path ends with a known image extension. */
export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.test(path);
}
