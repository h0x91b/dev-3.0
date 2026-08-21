Short: Throwaway board for browser QA

`bun run dev --qa` now launches the app against a throwaway data root instead of your real board, so browser verification cannot click another task's "Branch Merged" dialog or reach another task's live terminal. `--qa=virgin` gives a completely empty home — the state a brand-new user is in. `$DEV3_HOME` is now honoured by one shared resolver across the app, the CLI and the native terminal paths, which previously disagreed and produced a half-redirected instance.
