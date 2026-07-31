export function formatBytes(bytes: number): string {
	if (bytes < 1024) return bytes + " B";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
	if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + " MB";
	return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

/**
 * Compact size for the global-header memory pill, where the number IS the widget:
 * "12 GB", "1.4 GB", "512 MB". The unit is spelled out — with no glyph beside it a
 * bare "12G" reads as a code rather than a quantity.
 *
 * Below 10 GB it keeps one decimal, because the gap between 1.4 GB and 1.9 GB
 * decides whether another task fits; above that the decimal is noise.
 */
export function formatBytesCompact(bytes: number): string {
	const gib = bytes / 1024 ** 3;
	if (gib >= 10) return `${Math.round(gib)} GB`;
	if (gib >= 1) return `${gib.toFixed(1)} GB`;
	return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}
