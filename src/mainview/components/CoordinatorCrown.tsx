/** Crown before a coordinator's title; inline so a long title still wraps and clamps. */
export function CoordinatorCrown({ size }: { size: number }) {
	return (
		<svg
			data-testid="coordinator-crown"
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2.2}
			strokeLinecap="round"
			strokeLinejoin="round"
			className="mr-1.5 inline-block flex-shrink-0 align-[-2px]"
		>
			<path d="M2 18h20M4 18 2.5 7l5.5 4 4-7 4 7 5.5-4L20 18" />
		</svg>
	);
}
