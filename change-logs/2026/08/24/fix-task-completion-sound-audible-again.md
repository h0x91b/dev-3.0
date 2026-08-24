Short: Task completion chime is audible again

The task completion and cancellation chimes are audible again in packaged builds: Web Audio produces no sound at all in the app's WKWebView, so the chimes play through a short audio element instead. Both sounds were re-cut to 0.82s, which keeps them under the threshold above which macOS would hand them the hardware Play/Pause key and stop it from controlling Spotify.
