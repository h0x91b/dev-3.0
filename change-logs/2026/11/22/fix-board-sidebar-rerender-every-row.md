Short: Smoother big boards and Active Tasks sidebar

A change to one task no longer re-renders every card on the board, and the Active Tasks sidebar's one-second clock now updates only the age stamps whose text changes instead of re-rendering every row — on a 1,200-row sidebar that removes a ~140 ms main-thread stall every second.
