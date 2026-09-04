Short: Scroll-to-latest button on phones

On touch devices the terminal now shows a round scroll-to-latest button over the canvas whenever the pane is scrolled into history, and a tap returns to the live output (leaving tmux copy-mode or scrolling the native buffer to the bottom). Before, the tap that ends copy-mode on desktop was swallowed by the prompt composer, so the only way back on a phone was swiping through the whole history. Text sent from the composer while scrolled up now leaves copy-mode first instead of being eaten as copy-mode keys.
