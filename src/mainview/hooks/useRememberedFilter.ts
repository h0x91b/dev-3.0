import { useCallback, useState } from "react";

// In memory only, by design: a filter survives navigation but never an app restart,
// so a fresh launch cannot open on a board that silently hides tasks.
const rememberedFilters = new Map<string, string>();

/** Board filter key; a space board keeps its own filter apart from its anchor project. */
export function boardFilterKey(projectId: string, spaceId?: string | null): string {
	return spaceId ? `board:space-${spaceId}` : `board:${projectId}`;
}

/** Preset the filter a surface will open with — e.g. another board, before navigating there. */
export function rememberFilter(key: string, query: string): void {
	if (query) rememberedFilters.set(key, query);
	else rememberedFilters.delete(key);
}

export function resetRememberedFiltersForTests() {
	rememberedFilters.clear();
}

/**
 * A filter query that outlives the component showing it. Each key keeps its own
 * value, so switching boards A → B → A restores A's filter and B starts with its own.
 */
export function useRememberedFilter(key: string): [string, (next: string) => void] {
	const [state, setState] = useState(() => ({ key, query: rememberedFilters.get(key) ?? "" }));
	// Same component re-rendered for another board: load that board's filter.
	const current = state.key === key ? state : { key, query: rememberedFilters.get(key) ?? "" };
	if (current !== state) setState(current);

	const setQuery = useCallback((next: string) => {
		if (next) rememberedFilters.set(key, next);
		else rememberedFilters.delete(key);
		setState({ key, query: next });
	}, [key]);

	return [current.query, setQuery];
}
