Short: Windows dev build no longer dies on EBUSY

`bun run dev` on Windows failed before it could start, because Electrobun wipes its build folder with an un-retried delete and Windows refuses to remove a folder a running process sits in. Detached terminal hosts no longer inherit the app's bundle directory as their working directory, and a new pre-build step clears the folder first — terminating only this build's own app processes, never a `dev3` CLI that might be serving another task. macOS and Linux are untouched.
