/**
 * A space's own glyph: three sheets seen as one stack. It is the only thing in
 * the app that says "several projects read as one board" without a caption, and
 * it stays three strokes down to 14px. Deliberately not a folder (that is a
 * project), not a 2x2 grid (that is a layout toggle), not a tag (those are task
 * labels) — each of those spends a meaning dev3 already uses elsewhere.
 */
function SpaceIcon({ className = "w-4 h-4" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.7}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M12 3.2 20.5 7.6 12 12 3.5 7.6z" />
			<path d="M3.5 12 12 16.4 20.5 12" />
			<path d="M3.5 16.4 12 20.8 20.5 16.4" />
		</svg>
	);
}

export default SpaceIcon;
