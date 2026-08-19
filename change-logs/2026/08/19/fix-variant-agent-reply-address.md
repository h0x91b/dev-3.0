Short: Variants get a working reply address

A cross-task agent message sent from a task variant now carries the sender's task id as the reply address instead of `seq:<N>`, which every variant of a group shares and which the CLI rejects as ambiguous. The same address is used for the reply command handed back after an agent-initiated launch.
