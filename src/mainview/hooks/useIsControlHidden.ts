import { useEffect, useState } from "react";
import type { HideableControlId } from "../hideable-controls";
import {
	HIDDEN_CONTROLS_CHANGED_EVENT,
	getHiddenControls,
	isControlHidden,
	isSimplifyViewApplied,
} from "../hidden-controls";

/** Whether one control is hidden, re-rendering when the hidden set changes. */
export function useIsControlHidden(id: HideableControlId): boolean {
	const [hidden, setHidden] = useState(() => isControlHidden(id));

	useEffect(() => {
		function onChanged() {
			setHidden(isControlHidden(id));
		}
		window.addEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, onChanged);
		// The set may have landed between render and this effect.
		onChanged();
		return () => window.removeEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, onChanged);
	}, [id]);

	return hidden;
}

/** The explicit Simplified Mode choice, independent of personal hidden controls. */
export function useIsSimplifyViewApplied(): boolean {
	const [applied, setApplied] = useState(isSimplifyViewApplied);

	useEffect(() => {
		function onChanged() {
			setApplied(isSimplifyViewApplied());
		}
		window.addEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, onChanged);
		onChanged();
		return () => window.removeEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, onChanged);
	}, []);

	return applied;
}

/** The whole hidden set, re-rendering on change — for "does this panel have anything hidden". */
export function useHiddenControls(): ReadonlySet<string> {
	const [hidden, setHidden] = useState(getHiddenControls);

	useEffect(() => {
		function onChanged() {
			setHidden(getHiddenControls());
		}
		window.addEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, onChanged);
		onChanged();
		return () => window.removeEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, onChanged);
	}, []);

	return hidden;
}
