Short: Coordinators read the event log

The default Coordinator role now begins a turn by reading `dev3 events` from the cursor it saved last time, drains every capped page, opens the notes that matter in full, and advances the cursor only after consuming the results. A lost cursor is bootstrapped as an openly bounded window instead of a short relative one, and a failed read is reported as a failed read rather than as a quiet board. The rest of the role text was condensed to pay for the addition, so a coordinator task costs no more of the launch command line than before.
