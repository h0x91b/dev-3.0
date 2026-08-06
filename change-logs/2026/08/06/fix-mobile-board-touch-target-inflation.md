Short: Mobile board no longer looks inflated

Fixed the phone Kanban board: the global touch-target rule forced every button to 44×44, which blew carousel dots into big grey circles and inflated label chips and priority badges. The floor is now 24×24 and no longer overrides a component's own size, while bottom-sheet rows keep true 44px targets; the column dots are gone and the pager shows only the position, since the column header right below already names the column.
