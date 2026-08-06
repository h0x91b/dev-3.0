Short: Phone UI is half the size

Fixed the phone UI being sized for a mouse: the global touch-target rule forced every button to 44×44 (inflating carousel dots, label chips and priority badges) and its `:is()` selector silently overrode each component's own size. The floor is now 24×24 via `:where()`, bottom-sheet rows keep true 44px targets, and the 0.67× density that only the terminal screen used now applies to every screen on a phone. The Kanban carousel dropped its column dots, and the Launch-task footer no longer breaks its button labels one word per line.
