Short: Stop button for the public tunnel

The Remote Access modal now shows an explicit Stop tunnel button next to "Public tunnel active", so shutting the public Cloudflare tunnel down no longer depends on discovering that you have to uncheck the "Accessible from anywhere" checkbox. The same modal became a real dialog along the way: it announces itself as one, traps keyboard focus, closes on Escape, and its tunnel-status line now uses the themed success color instead of a raw palette green that was unreadable in light mode.
