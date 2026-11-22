import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
import { isElectrobun } from "../rpc";
import { requestTerminalPaste, terminalPasteTarget } from "../terminal-paste-request";
import { fileManagerKeys } from "./file-manager";
import { CopyGlyph, ExternalGlyph, EyeGlyph, InsertGlyph, PathGlyph, RevealGlyph } from "./glyphs";
// Defines the slot before the plugin injects it.
import "./registry";
import type { FileMenuItem } from "./registry";

/**
 * Anything outside a conservative safe set gets single quotes, which mean the
 * same to POSIX shells and PowerShell; only an embedded quote is escaped the
 * POSIX way, so a name with `'` still needs care in PowerShell.
 *
 * A control byte never reaches the terminal: `ESC[201~` in a file name would end
 * bracketed paste and run the rest as typed input. Each one becomes an unquoted
 * `?`, which a POSIX shell globs back to the real file.
 */
export function quoteForShell(relPath: string): string {
	return relPath.split(CONTROL_BYTE).map(quotePart).join("?");
}

const CONTROL_BYTE = /[\u0000-\u001f\u007f-\u009f]/;

function quotePart(part: string): string {
	if (part === "") return "";
	return /^[\w./@%+=:,-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`;
}

const FILE_MENU_BUILTIN_ID = "builtin:file-menu";

const BUILTIN_ITEMS: Omit<FileMenuItem, "order">[] = [
	{ id: "builtin:open", region: "open", icon: EyeGlyph, when: ({ entry }) => entry.kind === "file", label: ({ t }) => t("fileExplorer.open"), run: ({ openFile }) => openFile() },
	{
		id: "builtin:insert",
		region: "path",
		icon: InsertGlyph,
		label: ({ t }) => t("fileExplorer.insertPath"),
		run: ({ entry, inPrimaryRoot, projectId, taskId, handOff }) => {
			// The terminal runs in the worktree or checkout: an extra folder's path only resolves absolute.
			requestTerminalPaste(terminalPasteTarget(projectId, taskId), `${quoteForShell(inPrimaryRoot ? entry.relPath : entry.path)} `);
			handOff();
		},
	},
	{ id: "builtin:copy-relative", region: "path", icon: CopyGlyph, label: ({ t }) => t("fileExplorer.copyRelativePath"), run: ({ entry, copyText }) => copyText(entry.relPath) },
	{ id: "builtin:copy-path", region: "path", icon: PathGlyph, label: ({ t }) => t("fileExplorer.copyPath"), run: ({ entry, copyText }) => copyText(entry.path) },
	// Desktop only: in a browser tab these would open the file on the host machine.
	{
		id: "builtin:open-system",
		region: "host",
		icon: ExternalGlyph,
		when: ({ entry }) => isElectrobun && entry.kind === "file",
		label: ({ t }) => t("fileExplorer.openSystem"),
		run: ({ entry, openWithSystem }) => openWithSystem(entry.path, "system"),
	},
	{ id: "builtin:reveal", region: "host", icon: RevealGlyph, when: () => isElectrobun, label: ({ t }) => t(fileManagerKeys().reveal), run: ({ entry, openWithSystem }) => openWithSystem(entry.path, "reveal") },
];

/** Required: the explorer's row menu is how a path reaches the terminal or the clipboard. */
export const BUILTIN_FILE_MENU_PLUGIN: BuiltinPlugin = {
	id: FILE_MENU_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: FILE_MENU_BUILTIN_ID,
			inject: ["fileMenu"],
			apply(pluginCtx: Context) {
				BUILTIN_ITEMS.forEach((item, order) => pluginCtx.fileMenu.register({ ...item, order }));
			},
		});
	},
};
