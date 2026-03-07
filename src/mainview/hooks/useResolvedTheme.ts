import { useSyncExternalStore } from "react";

function getTheme(): "dark" | "light" {
	if (typeof document === "undefined") return "dark";
	return (document.documentElement.dataset.theme as "dark" | "light") || "dark";
}

function subscribe(cb: () => void): () => void {
	const observer = new MutationObserver(cb);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => observer.disconnect();
}

export function useResolvedTheme(): "dark" | "light" {
	return useSyncExternalStore(subscribe, getTheme, () => "dark");
}
