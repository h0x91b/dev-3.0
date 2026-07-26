Short: Windows CLI talks to the app

On Windows the desktop app now publishes a loopback-only TCP endpoint record and the bundled dev3.exe CLI connects through it, so the existing CLI commands and the agent status hooks work there without a Unix socket. Generated hook commands also spell the CLI in a form the Windows Claude hook runner can execute. macOS and Linux keep using the same `.sock` transport unchanged.
