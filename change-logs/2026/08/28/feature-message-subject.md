Short: Every dev3 message needs a subject

`dev3 message` now requires `--subject`: one line, about six words, 80 characters at most, stored with the message and rendered as the row in the agent-traffic readout and log instead of the head of the body. Omitting it exits 17 with an error that shows the limit, a good and a bad example, a subject suggested from your own text, and the corrected command; an over-limit subject is rejected rather than truncated. Messages sent before this keep showing their body head — nothing is backfilled.
