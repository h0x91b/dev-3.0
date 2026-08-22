Short: Merge now merges the open PR

The git bar's Merge button merges the branch's open pull request through `gh` instead of squashing into the local base branch and pushing it, so review, branch protection and CI still gate the landing; the button reads "Merge PR" and names the PR in its confirmation. With no pull request it keeps squashing locally as before, and being behind the base no longer blocks the PR route.
