Mouse-drag copying in tmux now keeps the terminal at the current scrollback position instead of exiting copy-mode and jumping to live output. The copied selection still clears, and OSC 52 clipboard delivery is unchanged.

Suggested by @DolevSol (h0x91b/dev-3.0#978)
