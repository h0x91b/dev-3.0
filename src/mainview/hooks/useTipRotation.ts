import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { TipState } from "../../shared/types";
import { selectTip, ROTATION_INTERVAL_MS, type Tip, type TipContext } from "../tips";
import { api } from "../rpc";

interface UseTipRotation {
	tip: Tip | null;
	tipState: TipState | null;
	reloadTipState: () => void;
}

/**
 * Feature-discovery tip rotation shared by every tip carrier (Kanban board,
 * Active Tasks sidebar, …). Loads tip state, recomputes the current tip for the
 * given surface `context`, and auto-rotates every ROTATION_INTERVAL_MS — marking
 * the shown tip as seen so the pool drains across sessions.
 *
 * `context` is forwarded to selectTip() as a sort boost (surface-relevant tips
 * lead; the rest still surface once those drain). `disabled` mirrors
 * GlobalSettings.tipsDisabled; when omitted, the hook fetches it once so callers
 * without GlobalSettings in scope (e.g. the sidebar) still respect the setting.
 */
export function useTipRotation(context: TipContext, disabled?: boolean): UseTipRotation {
	const [fetchedDisabled, setFetchedDisabled] = useState<boolean | undefined>(undefined);
	useEffect(() => {
		if (disabled !== undefined) return;
		api.request.getGlobalSettings()
			.then((s) => setFetchedDisabled(!!s.tipsDisabled))
			.catch(() => setFetchedDisabled(false));
	}, [disabled]);

	// Optimistic: undefined (still loading) is treated as "not disabled", matching
	// the board's historical behavior of showing tips before settings resolve.
	const isDisabled = (disabled ?? fetchedDisabled) === true;

	const [tipState, setTipState] = useState<TipState | null>(null);
	const tip = useMemo(
		() => (tipState && !isDisabled ? selectTip(tipState, context) : null),
		[tipState, isDisabled, context],
	);

	// Mirror state/tip in refs so the rotation timer reads the latest values
	// instead of the (null) closure captured when the effect first ran.
	const tipStateRef = useRef<TipState | null>(null);
	const currentTipRef = useRef(tip);
	useEffect(() => { tipStateRef.current = tipState; }, [tipState]);
	useEffect(() => { currentTipRef.current = tip; }, [tip]);

	const reloadTipState = useCallback(() => {
		api.request.getTipState().then(setTipState).catch(() => {});
	}, []);

	const mountedRef = useRef(true);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		mountedRef.current = true;
		if (isDisabled) return;
		reloadTipState();
		function scheduleRotation() {
			timerRef.current = setTimeout(() => {
				if (!mountedRef.current) return;
				const state = tipStateRef.current;
				if (!state) {
					scheduleRotation();
					return;
				}
				const current = currentTipRef.current;
				api.request.updateTipState({
					seen: current ? { [current.id]: Date.now() } : {},
					rotationIndex: state.rotationIndex + 1,
				}).then((next) => {
					if (!mountedRef.current) return;
					setTipState(next);
					scheduleRotation();
				}).catch(() => {
					if (!mountedRef.current) return;
					scheduleRotation();
				});
			}, ROTATION_INTERVAL_MS);
		}
		scheduleRotation();
		return () => {
			mountedRef.current = false;
			clearTimeout(timerRef.current);
		};
	}, [isDisabled, reloadTipState]);

	return { tip, tipState, reloadTipState };
}
