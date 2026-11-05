Short: Diff search order and hidden hits

Search in the diff review now steps through lines top to bottom, counts unchanged lines once, finds hits inside collapsed context by expanding the file, and shows whether the current hit is on the old or new side. Every occurrence gets a readable fill in both themes, typing keeps the current hit when it still matches, and the view scrolls only when the hit is off screen.

Contributed by @diverru (h0x91b/dev-3.0#2045)
