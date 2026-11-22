Short: Cross-board task refs link correctly

A task created or edited from a task on another board now stores that board's bare `seq:N` / `pr:N` references qualified with that board (`seq:a1c9fe4e/N`), so they link to the right task instead of "No such task or PR on that board". Agent messages across boards qualify bare refs the same way. The CLI accepts the qualified form wherever it takes a task: `dev3 task show --task seq:a1c9fe4e/60` resolves on that board.
