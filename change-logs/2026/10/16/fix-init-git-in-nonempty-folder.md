Short: Add a non-empty folder without Git

Add Project no longer rejects a folder that has files but no Git repository: Local Folder and New now offer to initialize Git in place after a confirmation that spells out the change, then make a first commit holding only dev3's `.dev3/README.md` placeholder (or an empty one when the folder already has its own), so existing files are never staged or committed and stay untracked. A repository with no commits yet is offered the same first commit, a missing Git identity falls back to a local dev3 one for that commit only, and a failed attempt can simply be retried.

Suggested by @shamrai-nikita (h0x91b/dev-3.0#1976)
