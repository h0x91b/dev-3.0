Short: PR status recovers after a hung GitHub read

A PR status or open-PR read that hung past its 15-second deadline no longer blocks that pull request's status until restart: the in-flight cache entry now fails and is dropped the moment the deadline aborts it, so the next poll starts a fresh read.
