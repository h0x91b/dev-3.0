/** The explorer menus' outline glyphs: a lighter stroke to sit beside 12px regular text. Shared by the row menu and the header. */
export const menuGlyph = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function EyeGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
			<circle cx="12" cy="12" r="2.75" />
		</svg>
	);
}

export function InsertGlyph() {
	return (
		<svg {...menuGlyph}>
			<rect x="3" y="4.5" width="18" height="15" rx="2.5" />
			<path d="m7.5 10 2.5 2-2.5 2" />
			<path d="M12.5 14.5h4" />
		</svg>
	);
}

export function CopyGlyph() {
	return (
		<svg {...menuGlyph}>
			<rect x="8.5" y="8.5" width="12" height="12" rx="2" />
			<path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
		</svg>
	);
}

export function PathGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
			<path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
		</svg>
	);
}

export function ExternalGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M14 4h6v6" />
			<path d="M20 4 11 13" />
			<path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
		</svg>
	);
}

export function RevealGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3" />
			<path d="M3 6v12a2 2 0 0 0 2 2h6" />
			<circle cx="16.5" cy="16.5" r="3" />
			<path d="m21 21-2.4-2.4" />
		</svg>
	);
}
