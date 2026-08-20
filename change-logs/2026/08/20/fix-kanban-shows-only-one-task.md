Short: Kanban no longer drops every card

Fixed the Kanban board rendering only a single task after entering a project whose task list was fetched while a task update arrived. The board now merges live updates into the snapshot instead of discarding the whole snapshot, so leaving a task via the breadcrumb no longer requires a dashboard round trip to see the other cards.
