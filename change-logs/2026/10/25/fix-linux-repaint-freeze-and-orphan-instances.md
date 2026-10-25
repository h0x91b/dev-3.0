Short: Linux window keeps repainting after Alt+Tab

On Linux the dev-3.0 window no longer waits forever for a `_NET_WM_FRAME_DRAWN` reply the compositor never sends. That wait made GNOME/Xwayland windows stop repainting after window switching while the app kept running (`DEV3_GTK_FRAME_SYNC=on` brings back GTK's own frame sync for comparison). Launching dev-3.0 from the app launcher while it is still running with its window closed now reopens that window in the running instance instead of starting another backend on the same data.

Suggested by @elygoncalves (h0x91b/dev-3.0#2039)
