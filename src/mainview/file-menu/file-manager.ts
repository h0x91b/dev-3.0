import { isMac, isWindows } from "../utils/platform";

export type RevealKey = "fileExplorer.revealFinder" | "fileExplorer.revealExplorer" | "fileExplorer.reveal";
export type OpenRootKey = "fileExplorer.openRootFinder" | "fileExplorer.openRootExplorer" | "fileExplorer.openRoot";

/** The host's file manager by name: these items only exist in the desktop shell, whose OS is the host's. */
export function fileManagerKeys(): { reveal: RevealKey; openRoot: OpenRootKey } {
	if (isMac()) return { reveal: "fileExplorer.revealFinder", openRoot: "fileExplorer.openRootFinder" };
	if (isWindows()) return { reveal: "fileExplorer.revealExplorer", openRoot: "fileExplorer.openRootExplorer" };
	return { reveal: "fileExplorer.reveal", openRoot: "fileExplorer.openRoot" };
}
