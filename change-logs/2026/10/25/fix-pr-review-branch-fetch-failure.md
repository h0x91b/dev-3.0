Short: PR review reports a failed branch fetch

Creating a review from a same-repository pull request no longer reports success when `git fetch` of its branch fails: the New Task dialog and `dev3 task create --pr` now say the fetch failed and quote git's error, instead of launching a task that later dies with an invalid-reference error. The fetch for this explicit request also bypasses the background failure backoff and confirms `origin/<branch>` exists afterwards.
