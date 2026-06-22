import { useState, useEffect, useMemo, useCallback, type Dispatch, type SetStateAction } from "react";
import type { TipState } from "../../shared/types";
import { selectTip, type Tip, type TipContext } from "../tips";
import { api } from "../rpc";

interface UseTipRotation {
	tip: Tip | null;
	tipState: TipState | null;
	/** Apply the TipState returned by an updateTipState call (rotate / snooze). */
	applyTipState: Dispatch<SetStateAction<TipState | null>>;
}

/**
 * Feature-discovery tip loader shared by every tip carrier (Kanban board,
 * Active Tasks sidebar, …). Loads tip state and recomputes the current tip for
 * the given surface `context` (forwarded to selectTip() as a sort boost —
 * surface-relevant tips lead, the rest still surface once those drain).
 *
 * The rotation timer + progress bar live in TipCard (co-located with the Next
 * button and hover-to-pause), so rotation only runs while a card is mounted.
 * This hook just persists/derives state; `reloadTipState` re-reads after a
 * rotation so the next tip is computed.
 *
 * `disabled` mirrors GlobalSettings.tipsDisabled; when omitted, the hook fetches
 * it once so callers without GlobalSettings in scope (e.g. the sidebar) still
 * respect the setting.
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
	const reloadTipState = useCallback(() => {
		api.request.getTipState().then(setTipState).catch(() => {});
	}, []);

	useEffect(() => {
		if (!isDisabled) reloadTipState();
	}, [isDisabled, reloadTipState]);

	const tip = useMemo(
		() => (tipState && !isDisabled ? selectTip(tipState, context) : null),
		[tipState, isDisabled, context],
	);

	return { tip, tipState, applyTipState: setTipState };
}
