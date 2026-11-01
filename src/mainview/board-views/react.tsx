import { createContext, useContext, useEffect, useReducer, useSyncExternalStore } from "react";
import type { Context } from "cordis";
import type { BoardService } from "./board-service";
import type { RegisteredBoardView } from "./registry";
import { getBoardViewRegistry } from "./root";

/** The Cordis context a board view renders under — the registering plugin's own. */
export const CordisContext = createContext<Context | null>(null);

export function useCordis(): Context {
	const ctx = useContext(CordisContext);
	if (!ctx) throw new Error("useCordis() outside a board view");
	return ctx;
}

/** `ctx.board`, re-rendering the caller on every `board/changed`. */
export function useBoard(): BoardService {
	const ctx = useCordis();
	const [, bump] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		const off = ctx.on("board/changed", bump);
		return () => {
			off();
		};
	}, [ctx]);
	return ctx.board;
}

/** The registered board views, in display order. */
export function useRegisteredBoardViews(): readonly RegisteredBoardView[] {
	const registry = getBoardViewRegistry();
	return useSyncExternalStore(registry.subscribe, registry.list);
}
