Short: Clear the attention badge from the CLI

`dev3 attention --clear` takes the red badge back down and drops every accumulated reason with it, so an agent that raised an alert during an incident can lower it once the incident is over instead of leaving a badge that outlives its cause. Clearing is never queued or silenced — it goes through even while Focus Mode is on, and it also removes badge events that were queued for that task, so a cleared badge cannot reappear when the queue flushes.
