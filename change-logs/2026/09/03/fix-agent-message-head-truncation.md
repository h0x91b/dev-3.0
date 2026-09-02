Short: Long agent messages arrive whole

Messages sent between tasks with `dev3 message` no longer lose their beginning. Text is now
pasted into the receiving agent through a tmux paste buffer instead of typed, so a long
message arrives as one atomic paste rather than as several ~1 KB fragments the receiving
CLI could drop one of. Messages also keep a `<full-copy>` receipt from 512 bytes up instead
of 1 500, so the way back to the original text is there whenever anything can go wrong. The
native terminal backend is unchanged — it has no way to tell whether the running app accepts
a bracketed paste.
