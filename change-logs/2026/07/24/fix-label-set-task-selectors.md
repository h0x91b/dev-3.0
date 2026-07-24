`dev3 label set` now resolves full task IDs, ID prefixes, and stable `seq:N` selectors through the shared task resolver, while unknown selectors retain a clear error without mutating a task.
