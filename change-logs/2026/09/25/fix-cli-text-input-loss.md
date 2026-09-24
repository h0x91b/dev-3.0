Short: CLI text no longer silently loses characters

Long non-ASCII text sent through the `dev3` CLI (notes, task descriptions, messages) no longer comes back with `�` inside words: the app now decodes a request only once all of its bytes have arrived. `dev3 note add`, `dev3 task create` and `dev3 message` also refuse input that would have been partly dropped — text given both positionally and as a flag, several unquoted words, or a flag left without a value — instead of keeping one part and exiting 0, and `dev3 message -` now reads the body from stdin so code-heavy text can skip the shell.
