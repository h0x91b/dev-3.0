Short: PR merge reported once per agent

A PR followed by both a plain `dev3 pr watch` and a `dev3 pr watch --pr <N>` watch on the same pull request (a review task, or `--pr` naming the task's own PR) now tells the agent about its merge or close once and clears every watch on it, instead of sending a second merged message from the other watch.
