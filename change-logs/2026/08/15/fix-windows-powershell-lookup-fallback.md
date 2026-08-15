Short: Pane runs proved on Windows

The packaged Windows CI job now executes a real `dev3 pane run` and reads its log back — that path had never been run on Windows at all, only asserted about from macOS. The same step also settles why PowerShell resolution refuses instead of falling back to a PATH lookup when %SystemRoot% is missing: it launches that fallback for real and records Windows PowerShell failing to start with error 8009001d while reporting exit 0.
