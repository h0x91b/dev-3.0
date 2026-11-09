Short: Self-built installs name their source

Builds made with DEV3_DISABLE_UPDATES=1 never check for, download or apply updates, so a locally built app is not replaced by the next upstream release. Such builds, and dev-channel builds, also show their branch and commit in the window title, e.g. `dev-3.0 v1.63.0 · main@be3c8cea [...]`; released builds are unchanged.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2232)
