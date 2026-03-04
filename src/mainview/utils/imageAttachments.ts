const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const IMAGE_PATH_RE = /(\/[^\s"'<>]+?\.dev3\.0\/[^\s"'<>]+?\.(png|jpe?g|gif|webp|bmp|svg))/gi;

/**
 * Extract absolute image paths from text that live inside ~/.dev3.0/.
 * Returns a deduplicated array of paths.
 */
export function extractImagePaths(text: string): string[] {
	if (!text) return [];
	const matches = text.match(IMAGE_PATH_RE);
	if (!matches) return [];
	return [...new Set(matches)];
}

/** Check if a file path ends with a known image extension. */
export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.test(path);
}
