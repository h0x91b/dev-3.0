import { useEffect, useReducer, useSyncExternalStore } from "react";
import type { BoardService } from "./board-service";
import type { RegisteredBoardView } from "./registry";
import { getBoardViewRegistry } from "./registry";
import { useCordis } from "../plugins/react";

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
