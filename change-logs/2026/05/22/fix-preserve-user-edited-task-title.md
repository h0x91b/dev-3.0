Fix task titles being overwritten by the agent on session start when the user had manually renamed them via the UI. The agent skill now sees a `(user-edited)` marker in `dev3 current` and is told to never rename; as a backstop, the CLI's `dev3 task update --title` silently refuses to overwrite a non-empty `customTitle` unless `--force` is passed.

Suggested by @genrym (h0x91b/dev-3.0#564)
