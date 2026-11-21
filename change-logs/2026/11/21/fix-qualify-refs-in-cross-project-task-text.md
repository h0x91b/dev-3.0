Short: Cross-board task refs link correctly

A task created or edited from a task on another board now stores that board's bare `seq:N` / `pr:N` references qualified with that board (`seq:a1c9fe4e/N`), so they link to the right task instead of "No such task or PR on that board". Agent messages across boards qualify bare refs in prose the same way. A ref used as a CLI argument stays as written.
