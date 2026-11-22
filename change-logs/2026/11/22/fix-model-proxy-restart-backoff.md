Short: Model proxy retries until it starts

When the model proxy fails to start, for example because its vendor's server is temporarily down on a fresh install, dev3 now tries again by itself with growing pauses (5s up to 2 minutes) and the API models settings show when the next attempt is. A "Stop retrying" button, removing the last provider, or quitting the app cancels the retries, saving the catalog retries at once, and a slow first start gets 45 seconds instead of 20.
