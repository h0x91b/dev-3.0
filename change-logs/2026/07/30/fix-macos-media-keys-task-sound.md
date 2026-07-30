Short: Media keys stay with your music

Task completion and cancellation sounds now play through the Web Audio API instead of an `<audio>` element. On macOS, WebKit made any `<audio>` longer than 0.95s the system "Now Playing" session, so the 1.3-1.5s chimes hijacked the hardware Play/Pause keys — pressing Play replayed the chime instead of resuming Spotify or Music. Web Audio mixes as ambient sound, so the keys stay with whatever was really playing.

Suggested by @Paveltarno (h0x91b/dev-3.0#1176)
