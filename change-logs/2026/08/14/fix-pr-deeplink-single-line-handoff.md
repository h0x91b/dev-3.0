Short: Safer PR task-link handoff

The Create-PR prompt no longer carries a multi-line markdown block, so it cannot submit early on agents that read a newline as Enter; the footer travels as one line and the divider is described in words. The dev3 agent skill and the ask-dev3 map now also describe the footer and where to switch it off.

The single-line approach, the skill updates and the toggle tests are all @BnayaZil's work from h0x91b/dev-3.0#1344, and the origin-task link feature itself is his (h0x91b/dev-3.0#1339).
