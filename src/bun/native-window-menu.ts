// Hands our Window submenu to AppKit as NSApp.windowsMenu, so macOS adds its own
// window items there (window list; on macOS 15+ Fill, Center, Move & Resize,
// Full Screen Tile, "Move to <display>"). Electrobun never registers it.
// Native side: src/native/macos/dev3-window-menu.m —
// decisions/2026/10/06/register-native-windows-menu.md.
//
// Must run after EVERY ApplicationMenu.setApplicationMenu: each rebuild creates a
// fresh NSMenu tree, and AppKit would keep pointing at the discarded one.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { PATHS } from "./electrobun-platform";
import { createLogger } from "./logger";

const log = createLogger("native-window-menu");

export interface WindowsMenuAdopterDeps {
	platform: NodeJS.Platform;
	headless: boolean;
	dylibPath: () => string;
	exists: (path: string) => boolean;
	load: (path: string) => () => void;
}

/**
 * Returns the function to call after each menu rebuild. It loads the shim once,
 * on first use; on non-macOS, headless mode, or a missing/broken dylib it is a
 * permanent no-op, so the menu keeps working with Electrobun's items only.
 */
export function createWindowsMenuAdopter(deps: WindowsMenuAdopterDeps): () => void {
	let adopt: (() => void) | null | undefined;

	const resolve = (): (() => void) | null => {
		if (deps.platform !== "darwin" || deps.headless) return null;
		const dylib = deps.dylibPath();
		if (!deps.exists(dylib)) {
			log.info("window-menu shim dylib not found — macOS window items stay unavailable", { dylib });
			return null;
		}
		try {
			return deps.load(dylib);
		} catch (err) {
			log.warn("window-menu shim failed to load", { error: String(err) });
			return null;
		}
	};

	return () => {
		if (adopt === undefined) adopt = resolve();
		if (!adopt) return;
		try {
			adopt();
		} catch (err) {
			log.error("dev3_window_menu_adopt failed", { error: String(err) });
		}
	};
}

export const adoptNativeWindowsMenu = createWindowsMenuAdopter({
	platform: process.platform,
	headless: process.env.DEV3_HEADLESS === "1",
	// Bundled next to dev3-notifications.dylib via the "dist/native" copy rule.
	dylibPath: () => join(PATHS.VIEWS_FOLDER, "..", "native", "dev3-window-menu.dylib"),
	exists: existsSync,
	load: (dylib) => {
		const lib = dlopen(dylib, { dev3_window_menu_adopt: { args: [], returns: FFIType.void } });
		return () => lib.symbols.dev3_window_menu_adopt();
	},
});
