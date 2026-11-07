Short: Dev window no longer loads foreign 5173 apps

The dev-channel window now looks for a Vite dev server only on the task-allocated `DEV3_PORT1` and loads the bundled UI when there is none, so another app answering on `localhost:5173` can no longer replace dev3 with its own page.
