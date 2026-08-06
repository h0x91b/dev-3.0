Short: Windows proof off PRs, onto main

The packaged Windows proof no longer makes pull requests wait — that cost about four
and three quarter minutes on every in-scope PR. It now runs post-merge on main, where a
break is attributable to a single commit, and it runs before anything publishes during a
release, so a release fails outright if the Windows app cannot be built and launched.
