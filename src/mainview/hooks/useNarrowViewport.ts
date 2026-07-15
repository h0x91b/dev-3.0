import { useEffect, useState } from "react";

export function useNarrowViewport(maxWidthPx: number): boolean {
	const [narrow, setNarrow] = useState(() =>
		typeof window !== "undefined" ? window.innerWidth < maxWidthPx : false,
	);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const mq = window.matchMedia(`(max-width: ${maxWidthPx - 1}px)`);
		const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
		setNarrow(mq.matches);
		if (typeof mq.addEventListener === "function") {
			mq.addEventListener("change", handler);
			return () => mq.removeEventListener("change", handler);
		}
		mq.addListener?.(handler);
		return () => mq.removeListener?.(handler);
	}, [maxWidthPx]);

	return narrow;
}
