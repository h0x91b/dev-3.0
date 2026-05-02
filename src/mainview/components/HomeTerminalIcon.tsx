interface HomeTerminalIconProps {
	className?: string;
}

function HomeTerminalIcon({ className }: HomeTerminalIconProps) {
	return (
		<svg
			className={className}
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 100 100"
			fill="currentColor"
		>
			<defs>
				<mask id="home-terminal-icon-doorway">
					<rect width="100" height="100" fill="white" />
					<rect x="34" y="54" width="32" height="40" rx="4" fill="black" />
				</mask>
			</defs>
			<path
				d="M 16 52 L 50 18 L 84 52 L 72 52 L 72 86 L 28 86 L 28 52 Z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth={5}
				strokeLinejoin="round"
				strokeLinecap="round"
				mask="url(#home-terminal-icon-doorway)"
			/>
			<path
				d="M 40 65 L 47 72.5 L 40 80"
				fill="none"
				stroke="currentColor"
				strokeWidth={6}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<line
				x1="51"
				y1="80"
				x2="60"
				y2="80"
				stroke="currentColor"
				strokeWidth={6}
				strokeLinecap="round"
			/>
		</svg>
	);
}

export default HomeTerminalIcon;
