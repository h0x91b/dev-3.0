Short: Sending a review never loses it

Pressing "Send to agent" on a diff review could erase the whole review while the agent received nothing — the send reported success as soon as the keystrokes left dev3, which is not the same as the agent reading them. Sent comments are now marked as sent and kept, exactly like a single comment sent on its own, and clearing them stays the explicit Reset button. A second cause is fixed underneath: on a task with several agent panes and no recorded focus, the hand-off could be typed into whatever pane you were looking at, including a plain shell — it now always goes to an agent pane, and the chosen pane is written to the log.

Suggested by @diverru (Alexander Kiselyov)
