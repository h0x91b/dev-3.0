Short: Task setup no longer freezes the app

Creating a task whose clone paths hold a large tree (node_modules, build output) no longer freezes the rest of dev3: the copy-on-write clone now runs in a worker thread instead of blocking the app's main loop, and clone work across tasks preparing at once is limited to two copies at a time.
