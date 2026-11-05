Short: Fix Codex sandbox helper on macOS

dev3's Codex permission profile now grants read access to the Codex installation (its launcher directory and install root), so Codex's sandbox helper can start its own launcher instead of failing with `execvp() ... Operation not permitted`.

Contributed by @diverru (h0x91b/dev-3.0#2024)
