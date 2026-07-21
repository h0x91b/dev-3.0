Short: Terminal fills viewport on load

Fixed the terminal not filling the full viewport height on first load in remote/browser mode (a large empty area appeared below tmux). The terminal now keeps its own persistent resize observer and re-fits via term.resize, instead of handing off to ghostty's FitAddon.observeResize whose callback was dropped during the 50ms window fit() opens — the exact window the container's final layout growth landed in on a fresh browser load.
