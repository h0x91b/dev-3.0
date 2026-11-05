Short: Search native terminal scrollback

The terminal search bar (⌘F) now searches the scrollback of native-backend tasks directly in the terminal buffer instead of showing 0 matches, highlighting the current match and stepping with Enter / Shift+Enter. Native terminals also keep a much longer scrollback (about 33,000 lines at 120 columns instead of about 600), so scrolling up and search reach far older output.

Contributed by @diverru (h0x91b/dev-3.0#2100)
