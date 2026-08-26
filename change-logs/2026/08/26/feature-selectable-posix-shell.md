Short: Pick the shell dev3 runs

Settings → Terminal now has a Shell picker: automatic (your login shell, then whichever of zsh, bash or sh is installed) or a pinned zsh, bash or sh, with the picker naming any flavor this machine does not have. dev3 no longer assumes /bin/zsh exists, so a minimal Linux box with only a POSIX sh gets working terminals, dev3 on PATH via ~/.profile, a worktree-relative prompt, and generated wrapper scripts that stay clear of bash-only syntax.
