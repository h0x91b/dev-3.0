Short: dev3 projects get and set

`dev3 projects get` shows a project's machine-local Project Settings switches (name, Git workflow, data in the project folder, repository config, board copy), and `dev3 projects set <key> <value>` changes one with the same checks as the app. `dev3 config` cannot reach them, because they are not `.dev3` config keys. Only the user outside any task and coordinator tasks may change them; any other task gets exit 49.

Contributed by @fallenfuzz
