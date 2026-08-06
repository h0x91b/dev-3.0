/**
 * Glue between `window-manager.ts` and the Win32 calls: no-op everywhere except
 * Windows, and never fatal. An app that refuses to open a window because it could
 * not decorate it would be strictly worse than the default icon we already ship.
 */
import { join } from "node:path";
import { createLogger } from "../logger";
import { setWindowIcon } from "./window-icon";
import { loadWin32IconSurface } from "./win32-icon-surface";

const log = createLogger("window-icon");

/** Fire-and-forget: gives one freshly created window its taskbar icon on Windows. */
export function applyWindowsWindowIcon(handle: number | null | undefined): void {
	if (process.platform !== "win32") return;
	if (typeof handle !== "number" || handle === 0) {
		log.warn("No window handle to set an icon on; the window keeps the default Windows icon", { handle: String(handle) });
		return;
	}

	void (async () => {
		try {
			const surface = await loadWin32IconSurface();
			setWindowIcon(handle, { execPath: process.execPath, bundleRoot: process.cwd(), joinPath: join }, surface);
			log.info("Window and taskbar icon applied");
		} catch (error) {
			log.warn("Window icon not applied; the window keeps the default Windows icon", { error: String(error) });
		}
	})();
}
