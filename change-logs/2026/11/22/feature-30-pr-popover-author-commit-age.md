Short: PR popover shows author and commit age

The PR hover popover — on a `<pr:N>` link, in the terminal and on PR badges — now names who opened the pull request, linked to their GitHub profile, and how long ago its last commit landed ("2 hours ago", "yesterday"), with the exact time on hover. The data rides on the same GitHub query that already feeds the popover, so hovering costs no extra request.
