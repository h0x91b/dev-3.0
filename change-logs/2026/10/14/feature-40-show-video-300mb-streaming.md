Short: show-video accepts clips up to 300 MB

`dev3 show-video` now accepts MP4/WebM clips up to 300 MB (was 25 MB), and the viewer streams them with seekable HTTP range requests in both the desktop app and remote browser mode instead of loading the whole file into memory. Clips are copied into the task store without blocking the app, and a failed copy never leaves a broken file behind.
