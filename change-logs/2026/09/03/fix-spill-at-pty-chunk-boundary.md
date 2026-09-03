Short: Long inter-task messages arrive whole

A `dev3 message` between two tasks no longer types anything longer than one terminal read: past 1 000 bytes of the whole envelope the body is written to a file and the agent is handed the path, and a burst released together obeys the same limit instead of merging into one oversized stream. The lost heads reported in #1608 were the receiving Claude Code folding the first ~1 KiB chunk into a pasted-text attachment and dropping it at submit, so the only reliable fix is to never send a second chunk; the `<full-copy>` receipt that used to detect the loss is gone, because the file itself is now the copy.

Suggested by @yhattav (h0x91b/dev-3.0#1608)
