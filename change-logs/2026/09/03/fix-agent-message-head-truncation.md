Short: Long agent messages arrive whole

Messages sent between tasks with `dev3 message` no longer lose their beginning: text is pasted
into the receiving agent through a tmux paste buffer instead of typed, so a long message arrives
as one atomic paste rather than as several ~1 KB fragments the receiving CLI could drop one of.
The native terminal backend is unchanged — it cannot tell whether the running app accepts a
bracketed paste.
