Short: Live Artifacts update in place

Each task can now have one Live Artifact: a page that updates in place instead of adding versions, with its own small data store that the page and the agent share — the agent writes with `dev3 live set|patch`, the page reads and writes through `window.dev3.live`, and every open copy redraws at once. Turn any artifact live with the new Make live button or `dev3 live adopt`, and open it in a real browser tab that stays live (`dev3 live url`, or Open in browser); a new page reloads by itself and keeps what you typed.

Contributed by @sworgkh (h0x91b/dev-3.0#2035)
