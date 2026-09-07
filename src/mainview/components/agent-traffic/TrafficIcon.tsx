const paths = {
	clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2",
	check: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0m-13 0 3 3 5-6",
	info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6M12 7v1",
	error: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 6v7M12 16v1",
	calendar: "M5 5h14v16H5ZM8 2v6M16 2v6M5 11h14",
	play: "m8 5 11 7-11 7Z",
	pause: "M8 5v14M16 5v14",
	previous: "m17 5-9 7 9 7ZM5 5v14",
	next: "m7 5 9 7-9 7ZM19 5v14",
	fit: "M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5",
	follow: "M12 2v4m0 12v4M2 12h4m12 0h4M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0",
	minus: "M5 12h14",
	plus: "M5 12h14M12 5v14",
	replay: "M3 11a9 9 0 1 1 2 7M3 4v7h7",
	message: "M4 4h16v12H9l-5 4ZM8 8h8M8 12h5",
} as const;
export default function TrafficIcon({ name }: { name: keyof typeof paths }) {
	return (
		<svg className="traffic-icon" viewBox="0 0 24 24" aria-hidden="true">
			<path d={paths[name]} />
		</svg>
	);
}
