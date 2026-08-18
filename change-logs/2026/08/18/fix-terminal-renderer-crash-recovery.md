Short: Blank terminal now heals itself

A terminal pane that went permanently blank — ghostty-web's render loop stops for
good after a single throw inside a resize, so neither a window resize nor a
fullscreen toggle brought it back — now rebuilds itself and reattaches to the
still-running session. Both observed crashes are covered (an out-of-range
codepoint and a WASM out-of-bounds access), and if three rebuilds in a row fail
you get a toast offering the window reload that does fix it.
