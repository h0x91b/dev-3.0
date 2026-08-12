Short: Sound setting honored right after launch

The task-complete sound played on every UI-driven completion after a restart even when the setting was off, because the app never read global settings at boot — it held hardcoded defaults until the Settings screen was opened. Custom keyboard rebinds and the experimental terminal BiDi flag were stale the same way.

Suggested by @giladra-wix (h0x91b/dev-3.0#1337)
