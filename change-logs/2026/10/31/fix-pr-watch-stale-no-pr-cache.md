Short: pr watch finds a just-opened PR

`dev3 pr watch` no longer reports "no open pull request" right after `dev3 pr create`: it now forces a fresh PR lookup instead of reusing the board poller's cached "no PR" result for the branch, which could linger for up to a minute.
