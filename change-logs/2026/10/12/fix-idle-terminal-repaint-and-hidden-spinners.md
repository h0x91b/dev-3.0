Short: Lower idle CPU on Linux

An idle task terminal no longer touches its canvas every frame — the blinking cursor is now drawn only when it appears, disappears, moves or loses focus — and the hidden "complete" spinners on review rows and the tip progress bar stop driving per-frame repaints, which kept the WebKitGTK web process busy on Linux.

Suggested by @elygoncalves (h0x91b/dev-3.0#1949)
