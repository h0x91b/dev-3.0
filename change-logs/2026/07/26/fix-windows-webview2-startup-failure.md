Short: Clean failure when the window has no renderer

A Windows desktop launch with no interactive desktop or a broken WebView2 runtime used to keep running without any UI — the native window is created but its WebView2 controller fails afterwards, so the app logged "ready", served remote RPC and could not even be shut down, because the quit gate waits for a renderer that never existed. The launch now waits for the first dom-ready and, if none arrives, prints what to install or run instead and exits with the new code 8.
