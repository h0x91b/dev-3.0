Short: Fix freeze on notes with many slashes

Opening a finished task whose notes contained a long line with many slashes froze the app. Image-path detection no longer backtracks exponentially and now runs in near-linear time.
