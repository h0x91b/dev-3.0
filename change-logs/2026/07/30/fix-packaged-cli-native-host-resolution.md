Short: Remote mode can start native terminals

Running dev3 in remote or headless mode from an installed app could not start an experimental native terminal: the bundled CLI looked for the packaged host image next to itself instead of at the package root, so the task failed the availability check even though the image was there. The desktop app was unaffected, and no task ever silently fell back to tmux.
