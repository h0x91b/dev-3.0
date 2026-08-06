Short: File-path underlines stop flickering

Underlines on file paths in terminal output no longer blink while an agent is working: the overlay now repaints on the next animation frame instead of clearing itself and waiting out a debounce that never expired under continuous output.
