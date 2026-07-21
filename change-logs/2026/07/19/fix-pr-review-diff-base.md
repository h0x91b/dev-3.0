Short: Correct diff base for PR review

Fixed the branch diff, ahead/behind status, and rebase/merge base for PR-review and other tasks created on an existing branch. These tasks stored the checked-out branch as their base branch, so the diff compared the branch against itself and showed "No changes to show"; the comparison now falls back to the project's base branch and shows the branch's actual changes.
