Short: Tasks that close themselves

A task can now be opted in to completing itself: `dev3 task move --status completed --force` finishes it at once with no approval dialog, so scheduled and delegated work no longer waits on a click. The opt-in is per task and never self-granted — set it with `--self-completion on` on `dev3 task create`, on an automation (stamped onto every task it creates), or on `dev3 task update` from outside the task; without it `--force` is refused. In the app, the automation editor has a "When the work is done" field and the task inspector's completion chip gains a third state, "Agent completes it"; such a task no longer raises the post-merge completion prompt.

Contributed by @arditti (h0x91b/dev-3.0#2302)
