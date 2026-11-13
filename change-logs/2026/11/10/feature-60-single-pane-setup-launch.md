Short: Run setup and agent in one pane

A new "Same pane" startup order (`setupScriptLaunchMode: "single-pane"`) runs the project's setup script and then starts the agent in that same tmux pane, so no extra setup pane is left to close by hand. A failed setup still drops into a shell and shows the usual re-run or start-anyway card.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1526)
