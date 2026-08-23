Short: Task completion chime plays again

The task completion and cancellation chimes went silent on packaged builds: WebKit mutes an AudioContext created without a user gesture while still reporting it as running, so a completion arriving from the CLI before the first click in the window silenced every later chime for the whole app session. The audio context is now built only inside a gesture, sounds that arrive earlier are queued until the next click, and the unlock handlers stay installed so an interrupted context can recover.
