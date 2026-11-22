import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
import { isElectrobun } from "../rpc";
import { requestTerminalPaste, terminalPasteTarget } from "../terminal-paste-request";
import { isMac, isWindows } from "../utils/platform";
// Defines the slot before the plugin injects it.
import "./registry";
import type { FileMenuItem } from "./registry";

export type RevealKey = "fileExplorer.revealFinder" | "fileExplorer.revealExplorer" | "fileExplorer.reveal";
export type OpenRootKey = "fileExplorer.openRootFinder" | "fileExplorer.openRootExplorer" | "fileExplorer.openRoot";

/** The host's file manager by name: these items only exist in the desktop shell, whose OS is the host's. */
export function fileManagerKeys(): { reveal: RevealKey; openRoot: OpenRootKey } {
	if (isMac()) return { reveal: "fileExplorer.revealFinder", openRoot: "fileExplorer.openRootFinder" };
	if (isWindows()) return { reveal: "fileExplorer.revealExplorer", openRoot: "fileExplorer.openRootExplorer" };
	return { reveal: "fileExplorer.reveal", openRoot: "fileExplorer.openRoot" };
}

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

// Menu glyphs: one outline set, a lighter stroke to sit beside 12px regular text.
const menuGlyph = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function EyeGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
			<circle cx="12" cy="12" r="2.75" />
		</svg>
	);
}

function InsertGlyph() {
	return (
		<svg {...menuGlyph}>
			<rect x="3" y="4.5" width="18" height="15" rx="2.5" />
			<path d="m7.5 10 2.5 2-2.5 2" />
			<path d="M12.5 14.5h4" />
		</svg>
	);
}

function CopyGlyph() {
	return (
		<svg {...menuGlyph}>
			<rect x="8.5" y="8.5" width="12" height="12" rx="2" />
			<path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
		</svg>
	);
}

export function PathGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
			<path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
		</svg>
	);
}

function ExternalGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M14 4h6v6" />
			<path d="M20 4 11 13" />
			<path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
		</svg>
	);
}

export function RevealGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3" />
			<path d="M3 6v12a2 2 0 0 0 2 2h6" />
			<circle cx="16.5" cy="16.5" r="3" />
			<path d="m21 21-2.4-2.4" />
		</svg>
	);
}
