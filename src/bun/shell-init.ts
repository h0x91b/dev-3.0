// Shell init files for dev3 managed terminals.
// Writes a custom ZDOTDIR so zsh sessions get short worktree-relative
// paths in the prompt while still sourcing the user's own config.

import { mkdirSync, writeFileSync } from "node:fs";
import { defaultStyle, shellPromptSource } from "../shared/shell-prompt-styles";
import { loadSettingsSync } from "./settings";
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

// Fills the dev3_* variables a prompt style reads; the style itself is written
// separately (PROMPT_FILE) so Settings can swap it without touching this.
export const ZSH_PROMPT_ENGINE = `\
# ── dev3 prompt engine ───────────────────────────────────────────────
# Before every prompt, fills the dev3_* variables a prompt style reads:
#   dev3_task dev3_project dev3_path dev3_where dev3_branch dev3_git
#   dev3_dirty dev3_dur dev3_segments, and the Nerd Font glyphs
#   dev3_icon_branch dev3_icon_clock dev3_sep.
# Only inside a dev3 session (DEV3_WORKTREE_ROOT is set).
if [[ -n "$DEV3_WORKTREE_ROOT" ]]; then
  zmodload zsh/datetime 2>/dev/null
  autoload -Uz add-zsh-hook
  setopt PROMPT_SUBST
  typeset -g dev3_task dev3_project dev3_path dev3_where dev3_branch dev3_git dev3_dirty dev3_dur dev3_segments
  # Byte escapes, not \\u: those fail outright under a non-UTF-8 locale.
  typeset -g dev3_sep=$'\\xee\\x82\\xbc' dev3_icon_branch=$'\\xee\\x82\\xa0' dev3_icon_clock=$'\\xef\\x80\\x97'
  RPROMPT=

  _dev3_preexec() { _dev3_t0=$EPOCHREALTIME }

  # One git call per prompt. GIT_OPTIONAL_LOCKS=0 keeps it off index.lock,
  # which agents in the same worktree are racing for.
  _dev3_git_state() {
    dev3_git= dev3_dirty= dev3_branch=
    local line oid head s=0 u=0 n=0 a=0 b=0
    while IFS= read -r line; do
      case $line in
        "# branch.oid "*) oid=\${line#\\# branch.oid } ;;
        "# branch.head "*) head=\${line#\\# branch.head } ;;
        "# branch.ab "*) line=\${line#\\# branch.ab }; a=\${\${line%% *}#+}; b=\${\${line##* }#-} ;;
        "? "*) (( n++ )) ;;
        [12u]" "*) [[ \${line[3]} != . ]] && (( s++ )); [[ \${line[4]} != . ]] && (( u++ )) ;;
      esac
    done < <(GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 --branch 2>/dev/null)
    [[ -z $oid ]] && return
    (( s + u + n )) && dev3_dirty=1
    if [[ $head == "(detached)" ]]; then dev3_branch=\${oid[1,7]}; else dev3_branch=\${head//\\%/%%}; fi
    local g=
    (( s )) && g+=" +$s"; (( u )) && g+=" ~$u"; (( n )) && g+=" ?$n"
    (( a )) && g+=" ⇡$a"; (( b )) && g+=" ⇣$b"
    dev3_git=\${\${g:- ✓}# }
  }

  # Appends one angled segment; tracks the visible width alongside the markup.
  # Text is drawn in reverse video, so it takes the terminal's own background
  # colour: dark on the pastel fills of a dark theme, light on a light theme's.
  _dev3_seg() {
    local color=$1 text=$2
    [[ -n $_dev3_bg ]] && _dev3_ps+="%s%F{$_dev3_bg}%K{$color}$dev3_sep%k"
    _dev3_ps+="%F{$color}%S $text "
    _dev3_bg=$color
    (( _dev3_w += \${#text} + 3 ))
  }

  # Level 0 shows everything; each level hides one more thing, least useful
  # first: project, task, path (shortened, then gone), git (collapsed, then gone), timer.
  _dev3_build() {
    local level=$1 rel=$dev3_path
    _dev3_ps= _dev3_bg= _dev3_w=0
    (( level < 2 )) && [[ -n $dev3_task ]] && _dev3_seg magenta "#$dev3_task"
    (( level < 1 )) && [[ -n $dev3_project ]] && _dev3_seg blue "$dev3_project"
    if (( level < 4 )) && [[ -n $rel ]]; then
      (( level >= 3 )) && [[ $rel == */* ]] && rel="…/\${rel:t}"
      _dev3_seg cyan "$rel"
    fi
    if (( level < 6 )) && [[ -n $dev3_git ]]; then
      local git=" $dev3_git"
      (( level >= 5 )) && { [[ -n $dev3_dirty ]] && git=" ±" || git=" ✓"; }
      _dev3_seg \${\${dev3_dirty:+yellow}:-green} "$dev3_icon_branch$git"
    fi
    (( level < 7 )) && [[ -n $dev3_dur ]] && _dev3_seg white "$dev3_icon_clock $dev3_dur"
    _dev3_ps+="%s%F{\${_dev3_bg:-8}}$dev3_sep%f"
    (( _dev3_w += 1 ))
  }

  _dev3_precmd() {
    dev3_dur=
    if [[ -n $_dev3_t0 ]]; then
      local d=$(( EPOCHREALTIME - _dev3_t0 )); unset _dev3_t0
      if (( d >= 3600 )); then dev3_dur="$(( \${d%.*} / 3600 ))h$(( \${d%.*} % 3600 / 60 ))m"
      elif (( d >= 60 )); then dev3_dur="$(( \${d%.*} / 60 ))m$(( \${d%.*} % 60 ))s"
      elif (( d >= 2 )); then dev3_dur="\${d%.*}s"; fi
    fi
    dev3_task=\${DEV3_TASK_SEQ%%-*}
    local wt=$DEV3_WORKTREE_ROOT
    # PWD is the resolved path when the root was reached through a symlink.
    [[ $PWD != "$wt" && $PWD != "$wt"/* ]] && wt=\${wt:A}
    dev3_project=\${\${DEV3_PROJECT_NAME:-\${DEV3_WORKTREE_ROOT:t}}//\\%/%%} dev3_path=
    if [[ $PWD == "$wt" ]]; then :
    elif [[ $PWD == "$wt"/* ]]; then dev3_path=\${\${PWD#$wt/}//\\%/%%}
    else dev3_project= dev3_path=\${\${(%):-%~}//\\%/%%}; fi
    dev3_where=\${dev3_project}\${dev3_project:+\${dev3_path:+/}}\${dev3_path}
    _dev3_git_state
    local level
    # Styles put a frame or an arrow around the segments: keep a few columns spare.
    for level in 0 1 2 3 4 5 6 7; do
      _dev3_build $level
      (( _dev3_w < COLUMNS - 5 )) && break
    done
    dev3_segments=$_dev3_ps
  }

  add-zsh-hook preexec _dev3_preexec
  add-zsh-hook precmd _dev3_precmd
fi
`;

export const PROMPT_FILE = `${SHELL_INIT_DIR}/prompt.zsh`;

// Main init: source user's .zshrc, then set the chosen dev3 prompt style.
// A null promptSource means the user keeps the prompt from their own .zshrc.
function zshrc(promptSource: string | null): string {
	const prompt =
		promptSource === null
			? ""
			: `${ZSH_PROMPT_ENGINE}
# A custom style that fails to load must not leave the pane without a prompt.
if [[ -n "$DEV3_WORKTREE_ROOT" ]] && ! source "${PROMPT_FILE}"; then
  print -u2 "dev3: the custom prompt failed to load, using the default one"
  ${defaultStyle().source}
fi
`;
	return `\
# dev3: source user's zsh config, then override prompt
ZDOTDIR="$HOME" source "$HOME/.zshrc" 2>/dev/null

${prompt}
# ── Word motion on modifier+arrow ────────────────────────────────────
# zsh binds none of these out of the box, and macOS claims Ctrl+arrow for
# "move a space" system-wide, so Alt+arrow is the combo that reaches the
# shell. Runs after the user's .zshrc, so dev3 panes get it either way.
bindkey "^[[1;3D" backward-word   # Alt+Left
bindkey "^[[1;3C" forward-word    # Alt+Right
bindkey "^[[1;5D" backward-word   # Ctrl+Left, where the OS lets it through
bindkey "^[[1;5C" forward-word    # Ctrl+Right
`;
}

// ── bash init ───────────────────────────────────────────────────────
// Used when bash is the fallback shell (SHELL=bash or exec bash on error)

// Only zsh gets prompt styles; bash keeps dev3's own prompt unless the user
// chose to keep theirs.
const BASH_PROMPT = `\
# ── dev3 prompt ──────────────────────────────────────────────────────
# Same layout as the zsh prompt, minus the command timer (bash 3.2 on
# macOS has no sub-second clock or preexec hook).
if [[ -n "$DEV3_WORKTREE_ROOT" ]]; then
  _dev3_sep=$'\\xee\\x82\\xbc' _dev3_ico_git=$'\\xee\\x82\\xa0'

  _dev3_git_state() {
    _dev3_git= _dev3_dirty=0
    local line oid= head= s=0 u=0 n=0 a=0 b=0 xy
    while IFS= read -r line; do
      case $line in
        "# branch.oid "*) oid=\${line#\\# branch.oid } ;;
        "# branch.head "*) head=\${line#\\# branch.head } ;;
        "# branch.ab "*) line=\${line#\\# branch.ab }; a=\${line%% *}; a=\${a#+}; b=\${line##* }; b=\${b#-} ;;
        "? "*) n=$((n + 1)) ;;
        [12u]" "*) xy=\${line:2:2}; [[ \${xy:0:1} != . ]] && s=$((s + 1)); [[ \${xy:1:1} != . ]] && u=$((u + 1)) ;;
      esac
    done < <(GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 --branch 2>/dev/null)
    [[ -z $oid ]] && return
    (( s + u + n )) && _dev3_dirty=1
    [[ $head == "(detached)" ]] && _dev3_git+=" \${oid:0:7}"
    (( s )) && _dev3_git+=" +$s"; (( u )) && _dev3_git+=" ~$u"; (( n )) && _dev3_git+=" ?$n"
    (( a )) && _dev3_git+=" ⇡$a"; (( b )) && _dev3_git+=" ⇣$b"
    [[ -z $_dev3_git ]] && _dev3_git=" ✓"
  }

  # $1 ANSI colour 0-7, $2 text. Reverse video, as in the zsh prompt.
  _dev3_seg() {
    [[ -n $_dev3_bg ]] && _dev3_ps+="\\[\\e[27;3\${_dev3_bg};4$1m\\]$_dev3_sep\\[\\e[49m\\]"
    _dev3_ps+="\\[\\e[3$1;7m\\] \${2//\\\\/\\\\\\\\} "
    _dev3_bg=$1
    _dev3_w=$((_dev3_w + \${#2} + 3))
  }

  _dev3_build() {
    local level=$1 rel=$2 root=$3 task=\${DEV3_TASK_SEQ%%-*} git
    _dev3_ps="\\[\\e[90m\\]┌─" _dev3_bg= _dev3_w=2
    (( level < 2 )) && [[ -n $task ]] && _dev3_seg 5 "#$task"
    (( level < 1 )) && [[ -n $root ]] && _dev3_seg 4 "$root"
    if (( level < 4 )) && [[ -n $rel ]]; then
      (( level >= 3 )) && [[ $rel == */* ]] && rel="…/\${rel##*/}"
      _dev3_seg 6 "$rel"
    fi
    if (( level < 6 )) && [[ -n $_dev3_git ]]; then
      git=$_dev3_git
      if (( level >= 5 )); then (( _dev3_dirty )) && git=" ±" || git=" ✓"; fi
      if (( _dev3_dirty )); then _dev3_seg 3 "$_dev3_ico_git$git"; else _dev3_seg 2 "$_dev3_ico_git$git"; fi
    fi
    _dev3_ps+="\\[\\e[27;49;3\${_dev3_bg:-0}m\\]$_dev3_sep\\[\\e[0m\\]"
    _dev3_w=$((_dev3_w + 1))
  }

  _dev3_prompt() {
    local rc=$? wt=$DEV3_WORKTREE_ROOT root=\${DEV3_PROJECT_NAME:-\${DEV3_WORKTREE_ROOT##*/}} rel= level arrow=35
    # PWD is the resolved path when the root was reached through a symlink.
    [[ $PWD != "$wt" && $PWD != "$wt"/* ]] && wt=$(cd "$wt" 2>/dev/null && pwd -P)
    if [[ $PWD == "$wt" ]]; then :
    elif [[ $PWD == "$wt"/* ]]; then rel=\${PWD#"$wt"/}
    else root= rel=\${PWD/#$HOME/\\~}; fi
    _dev3_git_state
    for level in 0 1 2 3 4 5 6; do
      _dev3_build $level "$rel" "$root"
      (( _dev3_w < \${COLUMNS:-80} )) && break
    done
    (( rc )) && arrow=31
    PS1="$_dev3_ps\\n\\[\\e[90m\\]└─\\[\\e[\${arrow}m\\]▶\\[\\e[0m\\] "
    return $rc
  }
  PROMPT_COMMAND="_dev3_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi

`;

function bashrc(keepOwnPrompt: boolean): string {
	return `\
# dev3: source user's bash config, then override prompt
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"

${keepOwnPrompt ? "" : BASH_PROMPT}# Word motion on modifier+arrow — see the zsh block for why Alt, not Ctrl.
# Outside an interactive shell bash 5 answers every bind with "line editing not enabled".
if [[ $- == *i* ]]; then
  bind '"\\e[1;3D": backward-word'
  bind '"\\e[1;3C": forward-word'
  bind '"\\e[1;5D": backward-word'
  bind '"\\e[1;5C": forward-word'
fi
`;
}

// ── POSIX sh init ───────────────────────────────────────────────────
// Reached through `$ENV`, which dash / busybox ash read for interactive
// shells. dash has no PROMPT_COMMAND, but it does expand command substitution
// in PS1 on every prompt (verified against /bin/dash), so the same two-line
// frame works here — without colours, git state or narrow-pane fitting.
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

  _dev3_task() {
    [ -n "$DEV3_TASK_SEQ" ] && printf '#%s ' "\${DEV3_TASK_SEQ%%-*}"
  }

  PS1='┌─ $(_dev3_task)$(_dev3_short_path)
└─▶ '
fi
`;

// ── Write to /tmp ───────────────────────────────────────────────────

export interface ShellPromptChoice {
	shellPrompt?: string;
	shellPromptCustom?: string;
}

function storedPromptChoice(): ShellPromptChoice {
	try {
		return loadSettingsSync();
	} catch {
		return {};
	}
}

export function writeShellInit(choice: ShellPromptChoice = storedPromptChoice()): void {
	mkdirSync(SHELL_INIT_DIR, { recursive: true });
	const promptSource = shellPromptSource(choice.shellPrompt, choice.shellPromptCustom);

	// sh
	writeFileSync(`${SHELL_INIT_DIR}/.shrc`, SHRC);

	// zsh
	writeFileSync(`${SHELL_INIT_DIR}/.zshenv`, ZSHENV);
	writeFileSync(`${SHELL_INIT_DIR}/.zprofile`, ZPROFILE);
	writeFileSync(`${SHELL_INIT_DIR}/.zshrc`, zshrc(promptSource));
	writeFileSync(PROMPT_FILE, `${promptSource ?? ""}\n`);
	writeFileSync(`${SHELL_INIT_DIR}/.zlogin`, ZLOGIN);

	// bash
	writeFileSync(`${SHELL_INIT_DIR}/.bashrc`, bashrc(promptSource === null));
}
