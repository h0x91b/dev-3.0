Short: No PR-promotion retry storm on hibernated tasks

A hibernated task sitting in Your Review with an open PR no longer retries the move to Colleague Review on every PR poll (each attempt was rejected and logged as an error); the promotion now waits and happens on the first poll after the task is woken.
