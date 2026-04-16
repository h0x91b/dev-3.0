New tasks created from an existing branch now store that source branch as their task base branch, so Task compare, rebase, and PR defaults follow the branch they were spawned from instead of the project default.
Merge scripts now switch the project repository to the task base branch before squash-merging, and regression tests cover both behaviors.
