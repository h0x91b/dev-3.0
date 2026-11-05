Short: Agents keep the labels you picked

Labels you add to a task by hand in the app now survive once the task starts: the agent's session-start step attaches its labels with `dev3 label add`, and even a `dev3 label set` or `--clear` from an agent keeps the labels you picked, which only `dev3 label remove <id>` naming one takes off.
