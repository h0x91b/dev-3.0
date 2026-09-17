Short: Offer to undo a narrowed Codex config

An older dev3 wrote a permission profile into `~/.codex/config.toml` narrower than Codex's own default, which stops standalone Codex from starting a session on a Homebrew install. On machines where that is actually the case — macOS, a symlinked Codex binary, that exact profile — dev3 now offers once at startup to put the single line back, naming the file and the change before touching anything. "Not now" asks again next launch, "Don't ask again" never does, and dev3 still never edits that profile on its own.
