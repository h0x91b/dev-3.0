Short: Tasks can depend on tasks

A task can name the tasks it depends on with `dev3 task create|update --depends-on seq:A[,seq:B]` (remove with `--no-depends-on`). The card shows "Blocked by #A" until they are done, `task show` and `tasks list` report blocked or ready and name a cancelled dependency as cancelled, and starting a blocked task warns but is allowed. A dependency never starts anything, a start-after condition set beside open dependencies warns that it will not wait for them, and a cycle is refused, including one through a `--start-after` condition.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2309)
