Short: + Agent no longer freezes on long sessions

Opening + Agent no longer freezes the app while it measures the task's conversation for "Continue this task's conversation": only the newest transcript is read, it is parsed in a background worker instead of on the thread that serves terminals, and reopening the dialog reuses the result.
