// Shell init files for dev3 managed terminals.
// Writes a custom ZDOTDIR so zsh sessions get short worktree-relative
// paths in the prompt while still sourcing the user's own config.

import { mkdirSync, writeFileSync } from "node:fs";
import { dev3TempPath } from "./temp-paths";

export const SHELL_INIT_DIR = dev3TempPath("dev3-shell");

// ── zsh init files ──────────────────────────────────────────────────

// Forward to user's .zshenv (always sourced, even non-interactive)
const ZSHENV = `\
# dev3: forward to user's .zshenv
[[ -f "$HOME/.zshenv" ]] && ZDOTDIR="$HOME" source "$HOME/.zshenv"
`;

// Forward to user's .zprofile (login shells only)
const ZPROFILE = `\
# dev3: forward to user's .zprofile
[[ -f "$HOME/.zprofile" ]] && ZDOTDIR="$HOME" source "$HOME/.zprofile"
`;

// Forward to user's .zlogin (login shells, after .zshrc)
const ZLOGIN = `\
# dev3: forward to user's .zlogin
[[ -f "$HOME/.zlogin" ]] && ZDOTDIR="$HOME" source "$HOME/.zlogin"
`;

// Main init: source user's .zshrc, then set dev3 prompt
const ZSHRC = `\
# dev3: source user's zsh config, then override prompt
ZDOTDIR="$HOME" source "$HOME/.zshrc" 2>/dev/null

# ── dev3 prompt ──────────────────────────────────────────────────────
# Shows path relative to worktree root + git branch.
# Only activates inside a dev3 session (DEV3_WORKTREE_ROOT is set).
if [[ -n "$DEV3_WORKTREE_ROOT" ]]; then
  _dev3_short_path() {
    if [[ "$PWD" == "$DEV3_WORKTREE_ROOT" ]]; then
      print -rn -- "."
    elif [[ "$PWD" == "$DEV3_WORKTREE_ROOT/"* ]]; then
      print -rn -- "./\${PWD#$DEV3_WORKTREE_ROOT/}"
    else
      print -rn -- "%~"
    fi
  }

  _dev3_git_branch() {
    local b
    b=$(git symbolic-ref --short HEAD 2>/dev/null) || \\
      b=$(git rev-parse --short HEAD 2>/dev/null) || return
    print -rn -- " ($b)"
  }

  setopt PROMPT_SUBST
  PROMPT='%F{blue}$(_dev3_short_path)%f%F{yellow}$(_dev3_git_branch)%f %# '
fi

# ── Word motion on modifier+arrow ────────────────────────────────────
# zsh binds none of these out of the box, and macOS claims Ctrl+arrow for
# "move a space" system-wide, so Alt+arrow is the combo that reaches the
# shell. Runs after the user's .zshrc, so dev3 panes get it either way.
bindkey "^[[1;3D" backward-word   # Alt+Left
bindkey "^[[1;3C" forward-word    # Alt+Right
bindkey "^[[1;5D" backward-word   # Ctrl+Left, where the OS lets it through
bindkey "^[[1;5C" forward-word    # Ctrl+Right
`;

// ── bash init ───────────────────────────────────────────────────────
// Used when bash is the fallback shell (SHELL=bash or exec bash on error)

const BASHRC = `\
# dev3: source user's bash config, then override prompt
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"

# ── dev3 prompt ──────────────────────────────────────────────────────
if [[ -n "$DEV3_WORKTREE_ROOT" ]]; then
  _dev3_short_path() {
    if [[ "$PWD" == "$DEV3_WORKTREE_ROOT" ]]; then
      echo -n "."
    elif [[ "$PWD" == "$DEV3_WORKTREE_ROOT/"* ]]; then
      echo -n "./\${PWD#$DEV3_WORKTREE_ROOT/}"
    else
      echo -n "\${PWD/#$HOME/~}"
    fi
  }

  _dev3_git_branch() {
    local b
    b=$(git symbolic-ref --short HEAD 2>/dev/null) || \\
      b=$(git rev-parse --short HEAD 2>/dev/null) || return
    echo -n " ($b)"
  }

  PS1='\\[\\e[34m\\]$(_dev3_short_path)\\[\\e[33m\\]$(_dev3_git_branch)\\[\\e[0m\\] \\$ '
fi

# Word motion on modifier+arrow — see the zsh block for why Alt, not Ctrl.
bind '"\\e[1;3D": backward-word'
bind '"\\e[1;3C": forward-word'
bind '"\\e[1;5D": backward-word'
bind '"\\e[1;5C": forward-word'
`;

// ── POSIX sh init ───────────────────────────────────────────────────
// Reached through `$ENV`, which dash / busybox ash read for interactive
// shells. dash has no PROMPT_COMMAND, but it does expand command substitution
// in PS1 on every prompt (verified against /bin/dash), so the same short path
// and branch a bash pane shows work here.
//
// Outside the worktree the prompt drops to the directory's own name: a full
// absolute path here would wrap the line, and there is no `%~` in POSIX.

const SHRC = `\
# dev3: source the user's own sh config, then override the prompt.
# The guard is load-bearing: dev3 itself runs inside these shells, so a stale
# DEV3_USER_ENV pointing back here would recurse until the shell dies.
if [ -z "$DEV3_SHRC_LOADED" ]; then
  DEV3_SHRC_LOADED=1
  [ -n "$DEV3_USER_ENV" ] && [ -f "$DEV3_USER_ENV" ] && . "$DEV3_USER_ENV"
fi

if [ -n "$DEV3_WORKTREE_ROOT" ]; then
  _dev3_short_path() {
    if [ "$PWD" = "$DEV3_WORKTREE_ROOT" ]; then
      printf .
    elif [ "\${PWD#$DEV3_WORKTREE_ROOT/}" != "$PWD" ]; then
      printf './%s' "\${PWD#$DEV3_WORKTREE_ROOT/}"
    else
      printf '%s' "\${PWD##*/}"
    fi
  }

  _dev3_git_branch() {
    b=$(git symbolic-ref --short HEAD 2>/dev/null) ||
      b=$(git rev-parse --short HEAD 2>/dev/null) || return 0
    printf ' (%s)' "$b"
  }

  PS1='$(_dev3_short_path)$(_dev3_git_branch) $ '
fi
`;

// ── Write to /tmp ───────────────────────────────────────────────────

export function writeShellInit(): void {
	mkdirSync(SHELL_INIT_DIR, { recursive: true });

	// sh
	writeFileSync(`${SHELL_INIT_DIR}/.shrc`, SHRC);

	// zsh
	writeFileSync(`${SHELL_INIT_DIR}/.zshenv`, ZSHENV);
	writeFileSync(`${SHELL_INIT_DIR}/.zprofile`, ZPROFILE);
	writeFileSync(`${SHELL_INIT_DIR}/.zshrc`, ZSHRC);
	writeFileSync(`${SHELL_INIT_DIR}/.zlogin`, ZLOGIN);

	// bash
	writeFileSync(`${SHELL_INIT_DIR}/.bashrc`, BASHRC);
}
