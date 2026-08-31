Short: Narrow artifact tables stack again

A plain table in a dev3 HTML artifact card no longer overflows its panel: the shell now makes the table's own parent the `dev3-table` query container, so the documented stacking into labelled lines works without an opt-in wrapper class. The shell also relabels cells when a report writes a whole table into a host element in one go, which is how report code normally renders one.
