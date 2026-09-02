Short: Message receipt covers every at-risk delivery

The `<full-copy>` receipt on an inter-task message now arms at 1 000 bytes of the typed envelope instead of 1 500 bytes of body: the lost-head defect turned out to be the receiving Claude Code folding the first ~1 KiB pty chunk into a pasted-text attachment and intermittently dropping it at submit, so anything longer than one read is exposed and the header counts toward that length. Deliveries that fit a single read stay as they were, with no receipt line.

Suggested by @yhattav (h0x91b/dev-3.0#1608)
