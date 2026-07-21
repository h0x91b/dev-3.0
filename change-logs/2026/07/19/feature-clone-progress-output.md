Short: Live output when cloning repos

The Add Project → Clone from URL modal now shows live `git clone` output while cloning: a terminal-style box displays the last four progress lines (remote counting, receiving objects, resolving deltas), so large repository clones are no longer a silent "Cloning…" button. Clone failures also report a clean terminal-style error tail instead of raw progress spam.
