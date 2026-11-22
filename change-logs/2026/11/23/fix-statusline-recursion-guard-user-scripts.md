Short: Custom statusLine scripts no longer vanish

A custom Claude Code statusLine whose command merely mentioned both "dev3" and "statusline" — a script kept under `~/.dev3.0/` or named `my-statusline.sh` — was silently dropped by the `dev3 statusline` wrapper's recursion guard. The guard now matches only an actual `dev3 statusline` invocation, so those scripts show again next to dev3's usage segment.
