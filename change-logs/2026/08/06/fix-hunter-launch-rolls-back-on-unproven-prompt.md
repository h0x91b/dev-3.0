Short: Find bugs no longer leaves silent hunter panes

Launching bug hunters on a tmux task now waits for each hunt prompt to actually reach its pane instead of firing it blind. If a pane provably never got its prompt, the whole launch is undone and you get an error naming that pane, rather than a hunter sitting at an empty prompt you would have to notice and close by hand. A delivery whose fate cannot be proven keeps its pane. The visible trade-off: the Find bugs action now takes about five seconds before it finishes, the way it already did on the native terminal backend.

Declared ride-along, unrelated to the fix above: `decisions/209-required-checks-wait-for-windows-packaging.md` stated the new Windows gate's cost as about +4 minutes, which the gate's first live run measured at +4m45 — corrected here with the run id and the reason the first estimate was low, because the estimate came from per-job durations and the scope job runs serially in front of the packaging jobs.
