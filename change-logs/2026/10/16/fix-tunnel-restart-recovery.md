Short: Tunnels recover after outages

The remote-access tunnel now comes back on its own after a network outage or a crashed connector: restarts wait for the old process to exit instead of colliding with it, and a tunnel that goes down is retried with backoff until it is up again or you stop it.
