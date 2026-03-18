// Shell init files for dev3 managed terminals.
// Writes a custom ZDOTDIR so zsh sessions get short worktree-relative
// paths in the prompt while still sourcing the user's own config.

import { mkdirSync, writeFileSync } from "node:fs";

export const SHELL_INIT_DIR = "/tmp/dev3-shell";

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
      echo -n "\\w"
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
`;

// ── Write to /tmp ───────────────────────────────────────────────────

export function writeShellInit(): void {
	mkdirSync(SHELL_INIT_DIR, { recursive: true });

	// zsh
	writeFileSync(`${SHELL_INIT_DIR}/.zshenv`, ZSHENV);
	writeFileSync(`${SHELL_INIT_DIR}/.zprofile`, ZPROFILE);
	writeFileSync(`${SHELL_INIT_DIR}/.zshrc`, ZSHRC);
	writeFileSync(`${SHELL_INIT_DIR}/.zlogin`, ZLOGIN);

	// bash
	writeFileSync(`${SHELL_INIT_DIR}/.bashrc`, BASHRC);
}
