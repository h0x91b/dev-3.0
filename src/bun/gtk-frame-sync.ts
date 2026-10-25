// Turns off GTK3's X11 frame synchronization for our windows on Linux.
//
// GTK3 freezes a window's frame clock after every frame until the compositor
// answers `_NET_WM_FRAME_DRAWN`, with no timeout. Mutter on Xwayland can drop
// that answer (gnome-shell logs "Frame has assigned frame counter but no frame
// drawn time"), and the window never paints again while the web process keeps
// running — issue #2039. See decisions/2026/10/25/disable-gtk-x11-frame-sync.md.

import { createLogger } from "./logger";

const log = createLogger("gtk-frame-sync");

/** Set to `on` to keep GTK's own frame sync (A/B diagnostics on a real desktop). */
export const GTK_FRAME_SYNC_ENV = "DEV3_GTK_FRAME_SYNC";

export interface GtkFrameSyncCalls {
	/** `gtk_widget_get_window` — 0 until the toplevel is realized. */
	gdkWindowOf: (widget: number) => number;
	/** `g_type_check_instance_is_a(gdkWindow, gdk_x11_window_get_type())`. */
	isX11Window: (gdkWindow: number) => boolean;
	/** `gdk_x11_window_set_frame_sync_enabled(gdkWindow, FALSE)`. */
	disableFrameSync: (gdkWindow: number) => void;
}

export interface GtkFrameSyncDeps {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	load: () => Promise<GtkFrameSyncCalls>;
}

export type FrameSyncOutcome = "disabled" | "skipped-platform" | "kept-by-env" | "no-handle" | "not-realized" | "not-x11" | "unavailable";

/**
 * Returns the per-window call. GTK is loaded once, on first use; any failure to
 * load it makes the call a permanent no-op — the window keeps GTK's default.
 */
export function createFrameSyncDisabler(deps: GtkFrameSyncDeps): (widget: number | null | undefined) => Promise<FrameSyncOutcome> {
	let loading: Promise<GtkFrameSyncCalls | null> | undefined;

	return async (widget) => {
		if (deps.platform !== "linux") return "skipped-platform";
		if (deps.env[GTK_FRAME_SYNC_ENV] === "on") return "kept-by-env";
		if (typeof widget !== "number" || widget === 0) return "no-handle";
		loading ??= deps.load().catch((err) => {
			log.warn("GTK not loadable — window keeps GTK frame sync", { error: String(err) });
			return null;
		});
		const calls = await loading;
		if (!calls) return "unavailable";
		const gdkWindow = calls.gdkWindowOf(widget);
		if (!gdkWindow) return "not-realized";
		if (!calls.isX11Window(gdkWindow)) return "not-x11";
		calls.disableFrameSync(gdkWindow);
		return "disabled";
	};
}

async function loadGtkFrameSyncCalls(): Promise<GtkFrameSyncCalls> {
	const { dlopen, FFIType } = await import("bun:ffi");
	const { ptr, bool, u64 } = FFIType;
	// Already mapped by Electrobun's native wrapper, so these resolve to the
	// same GTK instance that owns the window.
	const gtk = dlopen("libgtk-3.so.0", { gtk_widget_get_window: { args: [ptr], returns: ptr } } as const);
	const gdk = dlopen("libgdk-3.so.0", {
		gdk_x11_window_get_type: { args: [], returns: u64 },
		gdk_x11_window_set_frame_sync_enabled: { args: [ptr, bool], returns: FFIType.void },
	} as const);
	const gobject = dlopen("libgobject-2.0.so.0", { g_type_check_instance_is_a: { args: [ptr, u64], returns: bool } } as const);
	const x11WindowType = gdk.symbols.gdk_x11_window_get_type();

	return {
		gdkWindowOf: (widget) => Number(gtk.symbols.gtk_widget_get_window(widget as never) ?? 0),
		isX11Window: (gdkWindow) => gobject.symbols.g_type_check_instance_is_a(gdkWindow as never, x11WindowType),
		disableFrameSync: (gdkWindow) => gdk.symbols.gdk_x11_window_set_frame_sync_enabled(gdkWindow as never, false),
	};
}

const disableForWindow = createFrameSyncDisabler({ platform: process.platform, env: process.env, load: loadGtkFrameSyncCalls });

/** Fire-and-forget; call once the window is realized (dom-ready). Never throws. */
export function disableGtkFrameSync(widget: number | null | undefined, windowId: number): void {
	disableForWindow(widget).then(
		(outcome) => {
			if (outcome !== "skipped-platform") log.info("GTK frame sync", { windowId, outcome });
		},
		(err) => log.warn("Disabling GTK frame sync failed — window keeps the default", { windowId, error: String(err) }),
	);
}
