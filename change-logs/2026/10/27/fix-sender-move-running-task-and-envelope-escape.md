Short: Sender moves and envelopes hardened

An external sender (`--as-sender`) can no longer move an already running task, which could silently start a review column agent; repeating a start is a no-op. Text a sender sends can no longer close or forge the message envelope the receiving agent reads.
