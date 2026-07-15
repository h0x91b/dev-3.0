import { useEffect, useRef } from "react";
import { registerBackLayer } from "../back-navigation";

/**
 * Register a layered surface (modal, bottom sheet, popover) in the Android
 * Back layer stack while mounted/enabled: a hardware Back press closes the
 * topmost registered layer instead of navigating (see back-navigation.ts).
 *
 * Overlays that already use `useEscapeKey` get this for free — reach for
 * this hook only for surfaces with their own Escape handling (e.g.
 * BottomSheet) or none at all.
 *
 * The callback is read through a ref so it is always current; only `enabled`
 * gates the registration.
 */
export function useBackLayer(
	onClose: () => void,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!enabled) return;
		return registerBackLayer(() => onCloseRef.current());
	}, [enabled]);
}
