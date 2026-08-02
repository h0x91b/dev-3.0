Short: Find bugs works on native tasks

Launching bug hunters on a native task failed with a tmux socket error, because the launch path always split a tmux pane. Hunters now open as real native panes through the shared backend-neutral pane API, get their prompt through the native pane, leave keyboard focus with the main agent, and a launch that cannot open every hunter is rolled back and reported instead of half-starting. tmux tasks are unchanged.
