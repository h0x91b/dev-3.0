Short: PR and stalled search tokens

Board and sidebar search understand `has:pr`, `pr:open` / `pr:merged` / `pr:closed` (the state of the task's current pull request, live or last known) and `is:stalled` (an in-progress or AI-review task whose status has not changed for 4 hours, i.e. an agent turn that never ended).
