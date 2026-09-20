Short: Automatic task status for Oh My Pi

Oh My Pi (`omp`) tasks now move between columns on their own: dev3 loads a generated status
extension into every omp session, which reports prompts, tool activity, approval waits and the
agent stopping to the board, and records the session id so recovery resumes the exact session.
omp's skill and system prompt now tell the agent not to move status by hand.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1544)
