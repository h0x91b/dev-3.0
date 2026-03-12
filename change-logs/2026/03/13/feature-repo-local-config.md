Project settings (setup/dev/cleanup scripts, clone paths, base branch, peer review toggle) can now be stored in `.dev3/config.json` inside the repo, making them shareable via git. Machine-specific overrides go in `.dev3/config.local.json` (auto-added to `.gitignore`). Priority: global < repo < local. Project Settings UI shows source badges and has "Save to Repo" / "Export to .dev3/config.json" buttons. CLI commands `dev3 config show` and `dev3 config export` are available.

Suggested by @Aviv-Rosental (h0x91b/dev-3.0#249)
