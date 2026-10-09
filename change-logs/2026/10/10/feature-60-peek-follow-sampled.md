Short: Follow a terminal with sampled peek

`dev3 peek --follow --interval <s>` keeps watching a pane: it prints the current screen at once, then samples once per interval and prints again only when the tail text changed, so a progress bar redrawing hundreds of times a second costs at most one snapshot per interval. `--json` emits NDJSON, `--lines`/`--pane` still apply, Ctrl-C stops it, and a backend that cannot read the screen prints its one snapshot and exits 29.
