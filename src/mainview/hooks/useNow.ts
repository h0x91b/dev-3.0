import { useEffect, useState } from "react";

/** The current time, re-read every `intervalMs`, so countdowns move without a push. */
export function useNow(intervalMs = 15_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}
