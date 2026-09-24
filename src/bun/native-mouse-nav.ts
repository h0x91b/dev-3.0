// Mouse Back/Forward via macOS swipe events (compiled shim).
//
// Logi Options+ and similar drivers turn a mouse's Back/Forward buttons into an
// NSEventTypeSwipe, which WKWebView never delivers to the page — so the
// renderer's mouse-button handler in App.tsx cannot see it. The shim
// (src/native/macos/dev3-mouse-nav.m) watches swipes in the main process and
// reports the direction here; we route it as the renderer's existing
// `go-back` / `go-forward` menu actions.
//
// See decisions/2026/10/15/mouse-back-forward-swipe-shim.md.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { dlopen, FFIType, JSCallback, type Pointer } from "bun:ffi";
import { PATHS } from "./electrobun-platform";
import { createLogger } from "./logger";

const log = createLogger("native-mouse-nav");

export type SwipeNavAction = "go-back" | "go-forward";

/** The shim reports +1 for a swipe with deltaX > 0 (Back) and -1 for deltaX < 0 (Forward). */
export function swipeDirectionToAction(direction: number): SwipeNavAction | null {
	if (direction > 0) return "go-back";
	if (direction < 0) return "go-forward";
	return null;
}

// Module-level so the trampoline is never garbage-collected while the native
// monitor still holds its function pointer.
let swipeCallback: JSCallback | null = null;

/**
 * Load the shim and start forwarding swipes. Returns true when active; false on
 * non-macOS, headless mode, or a missing dylib (dev builds that skipped the
 * native build) — mouse drivers that send real buttons 3/4 still work then.
 */
export function initNativeMouseNav(onAction: (action: SwipeNavAction) => void): boolean {
	if (swipeCallback) return true;
	if (process.platform !== "darwin") return false;
	if (process.env.DEV3_HEADLESS === "1") return false;

	try {
		const dylib = join(PATHS.VIEWS_FOLDER, "..", "native", "dev3-mouse-nav.dylib");
		if (!existsSync(dylib)) {
			log.info("mouse-nav shim dylib not found — swipe back/forward disabled", { dylib });
			return false;
		}
		const lib = dlopen(dylib, {
			dev3_mousenav_init: { args: [FFIType.function], returns: FFIType.i32 },
		});
		// threadsafe: the monitor fires on the AppKit main thread, not the Bun worker.
		swipeCallback = new JSCallback(
			(direction: number) => {
				const action = swipeDirectionToAction(direction);
				if (action) onAction(action);
			},
			{ args: [FFIType.i32], returns: FFIType.void, threadsafe: true },
		);
		if (lib.symbols.dev3_mousenav_init(swipeCallback.ptr as Pointer) !== 1) {
			swipeCallback.close();
			swipeCallback = null;
			return false;
		}
		log.info("swipe back/forward channel active", { dylib });
		return true;
	} catch (err) {
		log.warn("mouse-nav shim failed to load — swipe back/forward disabled", { error: String(err) });
		swipeCallback?.close();
		swipeCallback = null;
		return false;
	}
}
