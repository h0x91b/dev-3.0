Short: Restore messages to running agents

Revert the readiness gate from PR #1792 because reconnecting to existing terminals and manually resumed agents could leave message delivery permanently blocked as still starting. This restores the previous delivery behavior while a corrected gate is developed; the original Claude trust-dialog handoff issue remains pending that follow-up.
