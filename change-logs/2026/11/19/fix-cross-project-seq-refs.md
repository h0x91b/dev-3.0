Short: Cross-project task links open correctly

A `<seq:N>` or `<pr:N>` in a message from a task on another project now opens the sender's task or PR, not the one with the same number on the receiver's board: dev3 adds the sender's project to those references when it delivers the message, including in long messages written to a file. The `seq:N` in a cross-project reply command also links to the right project, because its `--project` flag is now read as part of the reference.

Contributed by @BnayaZil (h0x91b/dev-3.0#2349)
