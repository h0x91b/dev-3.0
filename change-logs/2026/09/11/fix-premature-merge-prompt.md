Short: No merge prompt on brand-new tasks

A task whose branch had not written a single commit could be told its branch was merged and be offered completion, because the merge check read the empty diff against the base as a delivered merge — most visibly in projects with no remote. The check now asks for positive proof that work landed (a merge commit carrying the branch head, or a commit the branch made that the base now contains), and that same proof also detects a purely local merge, which previously only a merged GitHub PR could.
