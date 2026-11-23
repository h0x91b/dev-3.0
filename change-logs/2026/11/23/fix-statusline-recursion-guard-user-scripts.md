Short: Custom statusLine scripts no longer vanish

A custom Claude Code statusLine whose command merely mentioned both "dev3" and "statusline" — a script kept under `~/.dev3.0/` or named `my-statusline.sh` — was silently dropped by the `dev3 statusline` wrapper's recursion guard. The command check now matches only an actual `dev3 statusline` invocation, so those scripts show again next to dev3's usage segment, and a `dev3 statusline` reached again through a wrapper script or alias no longer delegates a second time.

Contributed by @mcaldas (h0x91b/dev-3.0#2430)
