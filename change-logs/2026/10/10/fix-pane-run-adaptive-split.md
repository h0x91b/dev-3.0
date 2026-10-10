Short: Pane runs no longer shrink to strips

`dev3 pane run` now picks where each new pane goes instead of halving the newest one to the right: the first run takes the right half of your pane, later runs split only dev3's own output panes in whichever direction leaves the roomiest result, and your agent pane, other agents and panes you opened are never resized. When nothing fits a usable 40x8 pane, the run is refused with exit 29 instead of opening a sliver.
