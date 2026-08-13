Short: Turn the PR task link on or off

The deep link dev3 appends to pull requests is now a setting (Settings → Tasks, on by default), so a public PR need not advertise which tool opened it, and the footer itself says where to switch it off. The footer also stopped swallowing the auto-merge instruction, starts on its own line so Markdown renders a rule instead of a heading, and the https open page now resolves new-task links correctly.

Builds on the origin-task deep link contributed by @BnayaZil (h0x91b/dev-3.0#1339).
