Short: Epics group tasks across projects

Tasks now carry an optional epic, one short kebab-case name shared across projects. Set it with `dev3 task update --epic <name>` (`--epic ""` clears) or `dev3 task create --epic <name>`; a task created from inside a task that has an epic inherits it automatically unless `--epic` is passed, and the coordinator brief tells a coordinator to set its own epic at session start. The epic shows in `dev3 current` and `dev3 task show`.
