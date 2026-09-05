Short: Board moves join the events feed

`dev3 events` now carries board movements alongside notes: a task being created, changing column (completion and cancellation included), or moving into a custom column. `--kind note|move` filters between them, and a filtered run says its cursor only advances over that kind. Movements are recorded from this version onward — moves made earlier were never stored by any version and are never invented — and when the per-task cap has destroyed moves inside the range you asked for, the run says so instead of presenting a trimmed log as complete.
