import { cloneElement, useCallback, useReducer, type ReactElement } from "react";
import { initialState, reducer, type AppAction, type Route } from "../state";

/**
 * Render a route-driven component against the real reducer, so route-carried UI
 * state (the inline diff, which is a back/forward history step) behaves as it
 * does in the app. A `dispatch` mock already on the element still sees every
 * action, so tests can assert on it.
 */
export function RouteHost({ route, element }: { route: Route; element: ReactElement }) {
	const [state, dispatch] = useReducer(reducer, {
		...initialState,
		route,
		routeHistory: [route],
		historyIndex: 0,
	});
	const spy = (element.props as { dispatch?: (action: AppAction) => void }).dispatch;
	const forward = useCallback((action: AppAction) => {
		spy?.(action);
		dispatch(action);
	}, [spy]);
	return cloneElement(element, { route: state.route, dispatch: forward } as Partial<unknown>);
}
