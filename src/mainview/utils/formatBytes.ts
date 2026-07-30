export function formatBytes(bytes: number): string {
	if (bytes < 1024) return bytes + " B";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
	if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + " MB";
	return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

/**
 * Ultra-compact size for the global-header memory pill, where the whole widget
 * is one glyph plus one number: "12G", "1.4G", "512M".
 *
 * Below 10 GB it keeps one decimal, because the gap between 1.4 GB and 1.9 GB
 * decides whether another task fits; above that the decimal is noise.
 */
export function formatBytesCompact(bytes: number): string {
	const gib = bytes / 1024 ** 3;
	if (gib >= 10) return `${Math.round(gib)}G`;
	if (gib >= 1) return `${gib.toFixed(1)}G`;
	return `${Math.max(0, Math.round(bytes / 1024 ** 2))}M`;
}
