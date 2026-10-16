Short: Coordinator orders pass the auto-mode classifier

Claude Code's auto-mode classifier no longer refuses what a coordinator relays from the user — force-pushes, squash merges, branch resets and other git or PR management now go through in the receiving task just as if the user had asked there. dev3 stamps `<from-role>coordinator</from-role>` into the message envelope of a coordinator's `dev3 message`, and adds matching rules (plus one making a task's own branch and PR its to manage on request) to `autoMode.allow` in the user's Claude settings; hard_deny rules still apply.
