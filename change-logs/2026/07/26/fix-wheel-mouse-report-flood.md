Short: No more scroll garbage in the prompt

Scrolling fast through a long agent session no longer pastes fragments of mouse escape sequences (`<64;69;44M`) into the input box. Wheel reports are now rate-limited so a momentum flick cannot overrun the PTY's read window, and drag motion is reported once per cell instead of once per pixel.
