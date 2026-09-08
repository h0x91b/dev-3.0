Short: Approval delay in seconds or hours

The delay before an agent-launch request approves itself is now an amount plus a unit, so 15 seconds, 10 minutes and 1 hour all work instead of a fixed list of whole minutes; "never" stays its own switch. Longer delays actually work now — the CLI used to give up after a fixed 10 minutes and kill the waiting agent before the timer it was waiting on could fire. A dialog waiting behind another also starts its countdown when it reaches the screen, so a queued request can no longer approve itself unseen.
