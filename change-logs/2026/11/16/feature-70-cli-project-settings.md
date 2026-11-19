Short: dev3 projects get and set

`dev3 projects get` shows a project's machine-local Project Settings switches (name, Git workflow, data in the project folder, repository config, board copy), and `dev3 projects set <key> <value>` changes one with the same checks as the app. `dev3 config` cannot reach them, because they are not `.dev3` config keys. Only the user outside any task and coordinator tasks may change them; any other task gets exit 49. A value Project Settings would not offer in that state, such as messages in the board copy while the board copy is off, is refused with exit 50.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2328)
