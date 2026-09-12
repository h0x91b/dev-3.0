Short: Peek a task's terminal from Agent traffic

Selecting a task in the Agent traffic inspector now offers a Terminal snapshot: an explicit, refreshable text read of that task's terminal through the same `dev3 peek` contract the CLI uses, so you can see what an agent is doing without opening the task. It is text rather than a picture, and it names its own limits — a failed read says so and says nothing about whether the task is working, and a task on the native terminal backend is told in plain words that its backend publishes no screen to read.
