Short: Create coordinator or review tasks from the CLI

`dev3 task create` now takes `--type coordinator|pr-review|standard`, the same values `dev3 task update --type` accepts, so a task can be created with its role already set instead of created and then updated. The role brief is written into the description at creation, so a task launched straight away is told what it is rather than reading a badge its agent was never given.
