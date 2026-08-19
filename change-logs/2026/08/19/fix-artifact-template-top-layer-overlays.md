Short: Artifact menus stop getting clipped

Menus and dropdowns in dev3 HTML artifacts no longer get cut off by the card, scroller, or sticky table header around them: the artifact starter now opens every overlay in the browser top layer and places it against its trigger, flipping above when the viewport is short. The starter ships a `.popover` menu primitive with keyboard, Escape, and outside-click handling so report authors never hand-roll an absolutely positioned panel again, and enhanced selects get the same lift for free.
