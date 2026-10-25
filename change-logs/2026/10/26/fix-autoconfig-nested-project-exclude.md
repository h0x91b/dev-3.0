Short: Auto-configure ignores nested project configs

Auto-configure now writes the info/exclude rule for .dev3/config.local.json relative to the repository root, so a project that lives in a repository subfolder no longer shows its local config as untracked in git status; special characters in the folder path are escaped.
