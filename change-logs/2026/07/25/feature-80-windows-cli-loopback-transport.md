Short: Windows CLI talks to the app

On Windows the desktop app now publishes a loopback-only TCP endpoint record and the bundled dev3.exe CLI connects through it, so the existing CLI commands work there without a Unix socket. macOS and Linux keep using the same `.sock` transport unchanged.
