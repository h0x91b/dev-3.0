import { useEffect, type DependencyList } from "react";

/**
 * Register a window-level keydown listener.
 *
 * Use `capture: true` for shortcuts that must fire before focused elements
 * (e.g. ghostty-web terminal) can consume the event.
 */
export function useGlobalShortcut(
	handler: (e: KeyboardEvent) => void,
	deps: DependencyList,
	{ capture = false }: { capture?: boolean } = {},
) {
	useEffect(() => {
		window.addEventListener("keydown", handler, { capture });
		return () => window.removeEventListener("keydown", handler, { capture });
		// deps are caller-controlled — intentional exhaustive-deps suppression
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);
}
