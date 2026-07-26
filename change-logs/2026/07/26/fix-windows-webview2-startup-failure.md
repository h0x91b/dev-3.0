Short: No more crash when WebView2 fails

A Windows launch with no interactive desktop or a broken WebView2 runtime used to create a window whose webview never came up, and the first-paint resize nudge then segfaulted the app seconds later — or it kept running with no UI at all and could not even be shut down, because the quit gate waits for a renderer that never existed. The nudge now waits for the renderer, and a launch that never gets one prints what to install or run instead and exits with the new code 8.
