Short: Windows update no longer hangs

The Windows self-update could hang forever on a black console: the handover script waited on process image names, so a single leftover launcher.exe — or any unrelated Bun process on the machine — blocked it with no output at all. dev3 now runs its own swap script that waits on the app's actual process id, force-closes only what is still running from the folder being replaced, prints what it is doing, and keeps the window open with the reason when something genuinely fails.
