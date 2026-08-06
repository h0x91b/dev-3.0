Short: Usage limits park the task, not hide

When a Claude turn dies on an API error — a hit usage limit, an expired login, a billing block — the task now moves itself to Has Questions with a red attention badge and a desktop notification naming the reset time, instead of sitting in Agent is Working for hours. Claude Code fires its `StopFailure` hook instead of `Stop` in that case, which dev3 previously ignored.
