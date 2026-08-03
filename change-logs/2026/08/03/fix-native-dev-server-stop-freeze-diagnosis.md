Short: Diagnose native dev-server stop freeze

Diagnosis pass on the UI freeze after Stop Dev Server on a native task; the freeze itself is still unconfirmed and no behaviour changes. Closing the focused dev-server pane now hands focus to a surviving pane instead of leaving nothing focused and the viewer bar bound to a pane that is gone. Dev Server actions carry a correlation id their handler echoes, native viewer WebSocket lines name their pane, and the desktop bridge watchdog reports when it revives the socket.
