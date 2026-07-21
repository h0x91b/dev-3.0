Short: Completion sound in desktop Chrome

Fixed the task-completion sound not playing in remote mode on desktop Chrome (it worked on mobile). The sound now primes its audio element on the first user gesture and reuses that primed element, so the delayed completion push is honored by the desktop autoplay policy.
