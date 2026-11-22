import { defineAppSlot } from "../plugins/root";
import { SlotRegistry } from "../plugins/slot-registry";
import type { Context } from "cordis";
import type { TranslationKey } from "../i18n";
import type { AppActionContext } from "../app-actions";

// Internal slot: built-ins only until the extension API opens it (no manifest kind yet,
// so the runtime guard unloads any extension that registers here).
declare module "cordis" {
	interface Context {
		commands: CommandsRegistry;
	}
}

export type CommandCategory = "app" | "create" | "import" | "nav" | "git" | "devserver" | "task" | "terminal";

/** What context a command needs to be runnable in the current route. */
export type CommandScope = "always" | "project" | "task";

/** Where the palette is opened: the route's project and task, and the shell it runs in. */
export interface CommandContext {
	hasProject: boolean;
	hasTask: boolean;
	/**
	 * The current project is a virtual ("Operations") board: no git, dev server,
	 * setup/run scripts, or project terminal (its synthetic path is created lazily
	 * per task and has no repo). The palette hides those, like the inspector does.
	 */
	isVirtual?: boolean;
	/** The current project runs without the git workflow: no git or import commands. */
	gitless?: boolean;
	/** Browser remote mode (`dev3 remote`): host-local desktop effects are hidden. */
	remote?: boolean;
	/**
	 * The board views on offer, display names resolved. Each becomes a
	 * "Board view: X" command right after "Go to board" — built-ins and
	 * extensions alike, which the static native menu cannot list.
	 */
	boardViews?: readonly { id: string; name: string }[];
}

/** One ⇧⌘P palette command. It runs itself; nothing routes it by id. */
export interface CommandItem {
	/** `builtin:<name>` for built-ins. */
	id: string;
	/** Position in the palette's unfiltered list. */
	order: number;
	/** i18n key for the label shown (and fuzzy-matched) in the palette. */
	labelKey: TranslationKey;
	/** Interpolation values for `labelKey`, for commands generated at runtime. */
	labelVars?: Record<string, string>;
	category: CommandCategory;
	scope: CommandScope;
	/** An extra visibility rule, on top of scope and the project kind. */
	when?: (ctx: CommandContext) => boolean;
	run: (ctx: AppActionContext) => void | Promise<void>;
}

export class CommandsRegistry extends SlotRegistry<CommandItem> {
	constructor(ctx: Context) {
		super(ctx, "commands", { kind: "contribute", noun: "command" });
	}
}

export const getCommandsRegistry = defineAppSlot((root) => new CommandsRegistry(root));

/** Runs a palette command; a throw or a rejection is logged, never escapes into the caller. */
export function runCommandSafely(command: CommandItem, ctx: AppActionContext): void {
	const fail = (err: unknown) => console.error(`[commands] ${command.id} failed`, err);
	try {
		Promise.resolve(command.run(ctx)).catch(fail);
	} catch (err) {
		fail(err);
	}
}
