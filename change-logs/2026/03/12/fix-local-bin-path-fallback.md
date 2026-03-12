Add ~/.local/bin and ~/bin as fallback PATH directories. Tools installed via pip, pipx, or Claude CLI installer live in ~/.local/bin, which some shell configurations don't include in PATH. The app now appends these directories (if they exist on disk) after resolving the user's shell environment, ensuring commands like `claude` are found regardless of shell config. Also renamed HOMEBREW_FALLBACK_PATHS to FALLBACK_BIN_PATHS and included user-local dirs in system requirements checks.

Suggested by @shmulikf (h0x91b/dev-3.0#279)
