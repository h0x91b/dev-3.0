Short: Diff snapshots stored gzip-compressed

Task diff snapshots in `~/.dev3.0/worktrees/*/diffs/` are now written gzip-compressed (`.patch.gz`, about a quarter of the size), and `dev3 doctor --worktrees --gzip-diffs` compresses the plain `.patch` snapshots already on disk; older app versions keep working alongside them.
