Short: Artifact tables stack instead of scrolling

Tables in dev3 HTML artifacts no longer scroll sideways or drop columns on narrow screens. Below 768px of the table's own container each row becomes a stack of labelled lines, with the shell copying every column heading onto the cells beneath it, so a plain `<table>` needs no new markup to get it. This removes the `.evidence-table-scroll` horizontal scroller and the rule that hid the third and fifth column below 560px, which silently deleted data; print still gets real columns and a repeating header.
