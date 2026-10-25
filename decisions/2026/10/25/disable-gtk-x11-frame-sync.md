# Disable GTK3 X11 frame sync on our Linux windows

## 1. Context

Issue #2039: on GNOME/Wayland the window stops repainting after Alt+Tab. The renderer heartbeat and the terminal's ~60 fps keep going, and gnome-shell logs `Frame has assigned frame counter but no frame drawn time` for our window. Electrobun 1.18.1 always forces `GDK_BACKEND=x11` (`initializeGTK`, overwrite=1), so every dev3 window is an Xwayland client using the GTK path (`createGTKWindow`). That path has no RGBA visual, so the reporter's "32-bit ARGB" line does not come from it: that line is printed only by the CEF `createX11Window` path.

## 2. Investigation

- GTK 3.24.49 `gdkwindow-x11.c` (`gdk_x11_window_end_frame`) freezes the frame clock after every frame until `_NET_WM_FRAME_DRAWN` arrives. There is no timeout. Only that message or an unmap thaws it (`gdkdisplay-x11.c`).
- mutter 48.1 `meta-sync-counter.c:meta_sync_counter_complete_frame` prints exactly that warning when it retires a frame for which it never sent `_NET_WM_FRAME_DRAWN`. So one dropped reply is enough to deadlock GTK. Similar reports exist for other forced-X11 WebKitGTK apps on mutter with multiple monitors (opencode #11939, where native Wayland was the workaround).
- I reproduced it in Docker on ubuntu 25.04 arm64 (GTK 3.24.49, WebKitGTK 2.50.4, the reporter's versions). The setup was the real Electrobun 1.18.1 `libNativeWrapper.so`, Xvfb, and a synthetic compositor that answers frames and then drops exactly one answer. The window was depth 24 with both sync counters. After the drop, GTK's counter and the window pixels froze while page rAF kept counting at about 61/s. With this change applied, painting continued at the same frame rate.

## 3. Decision

`src/bun/gtk-frame-sync.ts` calls `gdk_x11_window_set_frame_sync_enabled(gtk_widget_get_window(win.ptr), FALSE)` through `bun:ffi` at every window's dom-ready (`window-manager.ts`). It runs on Linux only and only on an X11 GdkWindow. GTK then paces frames with its own clock instead of waiting on the compositor. `DEV3_GTK_FRAME_SYNC=on` keeps GTK's default, for A/B checks on a real desktop.

## 4. Risks

- The call runs on the Bun worker thread, not the GTK thread. It only reads the widget's `GdkWindow` pointer and writes a boolean that GTK reads at frame end. That race is benign, but GTK does not guarantee it.
- Without frame sync, mutter gets no frame timings from us. Smoothness during an interactive resize may differ, and that has not been measured on GNOME.
- The synthetic compositor proves the deadlock and the fix. It does not prove that mutter drops the reply on Alt+Tab: that is inferred from mutter's source plus the reporter's log line. It still needs confirmation on the reporter's machine.

## 5. Alternatives considered

- **Native Wayland GTK.** This is the confirmed workaround elsewhere. But Electrobun hardcodes X11 (setenv, `gdk_x11_*`, `XGrabKey` shortcuts), so it needs a native-wrapper change upstream.
- **Upgrading Electrobun.** Nothing shows a fix there.
- **A host-side "GTK stopped painting" watchdog.** This needs GTK frame-clock signals on the GTK thread, which means a native shim. It remains a follow-up.
- **Global env knobs** such as `WEBKIT_DISABLE_COMPOSITING_MODE`. They do not touch GTK's frame-sync wait.
