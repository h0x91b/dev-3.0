import { useCallback, useEffect, useState } from "react";

const LS_KEY = "dev3-diff-include-tests-v1";
const EVENT_NAME = "dev3:include-tests-changed";

// Reviewing starts on production code: tests are excluded until asked for.
// An explicit "1" from a user who turned them on earlier still wins.
function readPref(): boolean {
	try {
		return localStorage.getItem(LS_KEY) === "1";
	} catch {
		return false;
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
