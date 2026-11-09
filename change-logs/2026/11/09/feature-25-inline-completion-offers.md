Short: Completion offers no longer block the board

A merged branch or an agent asking to complete a task now shows a Complete task card over the corner of that task's terminal, plus a marker on its card and sidebar row, instead of a full-screen dialog; the terminal keeps its size and the offer survives a page reload. The strip waits until you decide, takes no focus, checks the branch for unsaved work before Complete is allowed (including for agent requests, which skipped that check before), and links to the setting that turns merge offers off.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2215)
