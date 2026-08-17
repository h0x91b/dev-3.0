Short: Window survives a resolution change

A window left hanging off every screen after a monitor resolution change (or a
wake) is now pulled back onto a display, instead of only being clamped on the
next app start. The same trigger writes one geometry line from the backend and
one from the renderer into the log, and a terminal refit that throws is no longer
swallowed silently — the three blind spots behind reports of a black terminal
after a resolution change.
