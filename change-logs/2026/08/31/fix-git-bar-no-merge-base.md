Short: Git bar stops inventing an ahead count

The task git bar could read "1889 ahead · 6 behind" for a branch that was two commits ahead: with a truncated local clone git finds no fork point and answers with each side's whole history instead of failing. The bar now says the base is unreachable and names the fix, the branch diff says it was never computed instead of showing "no changes", and Push, Create PR, Merge and Rebase say why they are off.
