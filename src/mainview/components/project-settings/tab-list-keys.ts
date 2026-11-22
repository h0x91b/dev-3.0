import type { KeyboardEvent } from "react";

/** Arrow / Home / End move between a tablist's tabs and select the one reached (WAI-ARIA tabs). */
export function handleTabListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
	const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
	const currentIndex = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
	let nextIndex = currentIndex;
	if (e.key === "ArrowRight" || e.key === "ArrowDown") {
		nextIndex = (currentIndex + 1) % tabs.length;
		e.preventDefault();
	} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
		nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
		e.preventDefault();
	} else if (e.key === "Home") {
		nextIndex = 0;
		e.preventDefault();
	} else if (e.key === "End") {
		nextIndex = tabs.length - 1;
		e.preventDefault();
	} else {
		return;
	}
	tabs[nextIndex].focus();
	tabs[nextIndex].click();
}
