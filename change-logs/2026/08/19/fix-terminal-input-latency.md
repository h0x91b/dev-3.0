Short: Terminal responds a frame sooner

The terminal no longer holds PTY output for an animation frame before handing it to the emulator, and the app no longer waits out the full 16 ms batch window before sending a lone keystroke echo — together roughly 33 ms off every character you type. A fast scroll flick now delivers the lines the pacer held back instead of dropping them, so scrolling stops short less often. Terminal latency is also measured now (`window.__dev3TerminalLatency()`, plus a summary in the log every minute).
