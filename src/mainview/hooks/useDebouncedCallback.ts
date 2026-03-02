import { useRef, useCallback, useEffect } from "react";

/**
 * Returns a debounced version of the callback.
 * Pending invocations are flushed on unmount so no edits are lost.
 */
export function useDebouncedCallback<T extends (...args: any[]) => any>(
	callback: T,
	delayMs: number,
): T {
	const callbackRef = useRef(callback);
	callbackRef.current = callback;

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const argsRef = useRef<Parameters<T> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				if (argsRef.current !== null) {
					callbackRef.current(...argsRef.current);
				}
			}
		};
	}, []);

	return useCallback((...args: Parameters<T>) => {
		argsRef.current = args;
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			argsRef.current = null;
			callbackRef.current(...args);
		}, delayMs);
	}, [delayMs]) as T;
}
