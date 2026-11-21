import { Context } from "cordis";
import type { BoardService } from "../board-views/board-service";
import { BoardViewRegistry } from "../board-views/registry";

// Declaration merging is the whole plugin API (D7): plugin authors get typed
// `ctx.board` / `ctx.boardViews` on the raw Cordis Context, no dev3 facade.
declare module "cordis" {
	interface Context {
		board: BoardService;
		boardViews: BoardViewRegistry;
	}
	interface Events {
		"board/changed"(): void;
	}
}

let root: Context | null = null;
let registry: BoardViewRegistry | null = null;

/**
 * The one renderer-wide Cordis root. The registry is constructed with it: a
 * `Service` provides itself synchronously, so a board can mount on the very
 * first frame without waiting for anything.
 */
export function getAppRoot(): Context {
	if (!root) {
		root = new Context();
		registry = new BoardViewRegistry(root);
	}
	return root;
}

export function getBoardViewRegistry(): BoardViewRegistry {
	getAppRoot();
	return registry!;
}

/** Load the built-in views into the root. Called once at renderer start. */
export function startBoardViews(builtins: ReadonlyArray<(ctx: Context) => unknown>): Context {
	const ctx = getAppRoot();
	for (const install of builtins) install(ctx);
	return ctx;
}

export function resetAppRootForTests(): void {
	root = null;
	registry = null;
}
