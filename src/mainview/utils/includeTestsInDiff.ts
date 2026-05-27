import { useCallback, useEffect, useState } from "react";

const LS_KEY = "dev3-diff-include-tests-v1";
const EVENT_NAME = "dev3:include-tests-changed";

function readPref(): boolean {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw === "0") return false;
		return true;
	} catch {
		return true;
	}
}

function writePref(value: boolean): void {
	try {
		localStorage.setItem(LS_KEY, value ? "1" : "0");
	} catch {
		/* ignore */
	}
	try {
		window.dispatchEvent(new CustomEvent<boolean>(EVENT_NAME, { detail: value }));
	} catch {
		/* ignore */
	}
}

export function useIncludeTestsInDiff(): [boolean, (next: boolean) => void] {
	const [includeTests, setIncludeTests] = useState<boolean>(() => readPref());

	useEffect(() => {
		function handler(event: Event) {
			const detail = (event as CustomEvent<boolean>).detail;
			if (typeof detail === "boolean") {
				setIncludeTests(detail);
			}
		}
		window.addEventListener(EVENT_NAME, handler);
		return () => window.removeEventListener(EVENT_NAME, handler);
	}, []);

	const update = useCallback((next: boolean) => {
		setIncludeTests(next);
		writePref(next);
	}, []);

	return [includeTests, update];
}
