Short: Fetches use each repo's own SSH identity

Background fetches no longer reuse one SSH connection for every github.com repo, so a machine with separate work and personal GitHub accounts stops getting "Repository not found" and can set up PR reviews again. A repo's own core.sshCommand is respected, and the branch picker's refresh always performs a fresh fetch.
