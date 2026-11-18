Short: Terminal recovers after an agent crash

After an agent in a task terminal exits or is killed, dev3 now restores the tty and switches off mouse tracking, extended keys, bracketed paste and the alternate screen, so the shell works again without `reset`.
