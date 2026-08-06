Short: One release build definition per platform

The four per-platform release builds moved out of release.yml into two reusable workflows, so a second trigger no longer means a fifth and sixth copy of the same steps. Two long-dead recovery branches in the release artifact script were revived and covered by tests — one of them had been unable to run since March.
