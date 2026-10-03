/**
 * The shell side of the agent delivery fence, spliced into the POSIX launch wrapper around
 * the agent (`buildCmdScript`). The wrapper is run by the user's login shell with the
 * shebang ignored, so every line here is plain POSIX sh that zsh and dash also accept: no
 * `$RANDOM`, no `<<<`, no `printf '\x..'` — bytes travel as octal tokens (`od -to1`), which
 * any POSIX `printf` decodes.
 *
 * After the agent exits the wrapper:
 *  1. ignores INT/QUIT/TSTP and switches the tty raw, so neither a Ctrl-C flush nor the
 *     1 KiB canonical line cap can drop what races in;
 *  2. closes the fence with ONE tmux compare-and-set that also stores a nonce and queues its
 *     sentinel behind every byte tmux already accepted — or, when its tmux binary is gone,
 *     asks the app to (a close request) and starts NO shell until an app acknowledges;
 *  3. reads until it has seen that sentinel, saving everything else to a file (never run);
 *  4. restores the tty and the signals, reports what it saved, and only then hands over.
 * See `decisions/2026/09/28/agent-delivery-fence.md`.
 */

import { isAgentFenceLaunchId } from "../shared/agent-fence";
import { posixShellQuote } from "../shared/platform-launch";

export interface AgentFenceWrapperOptions {
	/** Absolute path of the tmux client the app committed to — never a PATH lookup. */
	tmuxBinary: string;
	/** Random per launch; unique across instances and restarts. */
	launchId: string;
	taskId: string;
	/** Where raced input is saved (the task's `messages/`). */
	racedDir: string;
	/** The flat close-request index every app instance sweeps. */
	fenceDir: string;
}

/** Lines that go BEFORE the agent command: open the fence. */
export function agentFenceOpenLines(opts: AgentFenceWrapperOptions): string[] {
	assertOptions(opts);
	const q = posixShellQuote;
	return [
		`__DEV3_FTMUX=${q(opts.tmuxBinary)}`,
		`__DEV3_FLAUNCH=${q(opts.launchId)}`,
		`__DEV3_FTASK=${q(opts.taskId)}`,
		`__DEV3_FRACED=${q(opts.racedDir)}`,
		`__DEV3_FINDEX=${q(opts.fenceDir)}`,
		`__dev3_tmux() { [ -n "\${TMUX:-}" ] && [ -n "\${TMUX_PANE:-}" ] && "$__DEV3_FTMUX" -S "\${TMUX%%,*}" "$@" 2>/dev/null; }`,
		`__DEV3_FENCED=0`,
		...OPEN_BODY.split("\n"),
	];
}

/**
 * Lines that go right AFTER the agent's exit code is captured in `exitVar`, and before any
 * notice or the shell. Everything is a no-op when the fence never opened.
 */
export function agentFenceCloseLines(exitVar: string): string[] {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(exitVar)) throw new Error(`unsafe exit variable: ${exitVar}`);
	return FENCE_CLOSE_BODY.replaceAll("__EXITVAR__", exitVar).split("\n");
}

function assertOptions(opts: AgentFenceWrapperOptions): void {
	if (!opts.tmuxBinary.startsWith("/")) throw new Error("the fence needs an absolute tmux binary");
	if (!isAgentFenceLaunchId(opts.launchId)) throw new Error(`unsafe agent fence launch id: ${opts.launchId}`);
	if (!/^[0-9a-f-]{8,64}$/.test(opts.taskId)) throw new Error(`unsafe task id: ${opts.taskId}`);
}

// N4-R1: open only a pane that has no fence yet, as a compare-and-set that also stores a
// per-attempt opener nonce, and trust only a read-back of BOTH. Re-running this script in the
// same pane must not reopen its launch, so a closed fence stays closed and every pin of the
// first run stays refused. A non-empty fence is NEVER modified: an `open:<x>` found here is a
// live parent this run is nested in (an agent running a launch script), and its own close
// must stay valid. The nonce is checked before tmux is touched, so a failed one opens nothing.
const OPEN_BODY = String.raw`__dev3_on=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
__dev3_ov=""
if printf '%s' "$__dev3_on" | grep -Eq '^[0-9a-f]{16}$'; then
  __dev3_ov=$(__dev3_tmux if-shell -t "$TMUX_PANE" -F '#{==:#{@dev3_agent_input},}' \
    "set-option -p -t $TMUX_PANE @dev3_agent_input open:$__DEV3_FLAUNCH ; set-option -p -t $TMUX_PANE @dev3_fence_opener $__dev3_on" \; \
    display-message -p -t "$TMUX_PANE" "dev3-agent-fence:#{@dev3_agent_input} #{@dev3_fence_opener}")
fi
if [ -n "$__dev3_ov" ] && [ "$__dev3_ov" = "dev3-agent-fence:open:$__DEV3_FLAUNCH $__dev3_on" ]; then
  __DEV3_FENCED=1
elif [ -z "$__dev3_ov" ] || [ "$__dev3_ov" = "dev3-agent-fence: " ]; then
  printf '\033[2mdev3: delivery fence unavailable for this pane\033[0m\n'
else
  printf '\033[1;33mdev3: this pane already carries a delivery fence of another dev3 run. dev3 will not deliver messages to this run; start the agent from dev3 to receive them.\033[0m\n'
fi`;

// ` 037 d e v 3 - f e n c e :` as octal tokens; a sentinel is that + 16 bytes + ` 037`.
const FENCE_CLOSE_BODY = String.raw`trap '' INT QUIT TSTP
if [ "$__DEV3_FENCED" = 1 ]; then
  __DEV3_FTTY=""
  [ -t 0 ] && __DEV3_FTTY=$(stty -g 2>/dev/null) && stty -isig -icanon -iexten -ixon -echo min 0 time 3 2>/dev/null
  __DEV3_FSP=' 037 144 145 166 063 055 146 145 156 143 145 072'
  __DEV3_FTMP=""; __DEV3_FMODE=file; __DEV3_FTAIL=""; __DEV3_FSEEN=""; __DEV3_FWANT=""; __DEV3_FLAST=0
  __DEV3_FSAVED=0; __DEV3_FDROP=0; __DEV3_FSHOWN=0; __DEV3_FBARRIER=0; __DEV3_FCAP=1048576
  __dev3_oct() { printf '%s' "$1" | od -An -v -to1 | tr -s ' \n' '  ' | sed 's/^ *//; s/ *$//'; }
  __dev3_nonce() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
  __dev3_want() {
    case "|$__DEV3_FWANT" in *"|$1|"*) ;; *) __DEV3_FWANT="$__DEV3_FWANT$1|";; esac
    __dev3_r=$__DEV3_FWANT
    while [ -n "$__dev3_r" ]; do
      __dev3_w=${"$"}{__dev3_r%%|*}; __dev3_r=${"$"}{__dev3_r#*|}
      case "$__DEV3_FSEEN" in *"$__dev3_w"*) __DEV3_FBARRIER=1; return 0;; esac
    done
  }
  __dev3_emit() {
    [ -n "$1" ] || return 0
    __dev3_k=$(( (${"$"}{#1} + 1) / 4 ))
    if [ -z "$__DEV3_FTMP" ] && [ "$__DEV3_FMODE" = file ]; then
      __DEV3_FTMP=$(mktemp "${"$"}{TMPDIR:-/tmp}/dev3-raced.XXXXXX" 2>/dev/null) || __DEV3_FMODE=screen
    fi
    if [ "$__DEV3_FMODE" = file ]; then
      if [ "$__DEV3_FSAVED" -ge "$__DEV3_FCAP" ]; then
        [ "$__DEV3_FDROP" = 0 ] && printf '\n\033[1;31mdev3: saved-input limit (%s bytes) reached; further input is DISCARDED, not run\033[0m\n' "$__DEV3_FCAP"
        __DEV3_FDROP=$((__DEV3_FDROP + __dev3_k)); return 0
      fi
      if printf "$(printf '%s' "$1" | sed 's/ *\([0-7][0-7][0-7]\)/\\\1/g')" 2>/dev/null >>"$__DEV3_FTMP"; then
        __DEV3_FSAVED=$((__DEV3_FSAVED + __dev3_k)); return 0
      fi
      __DEV3_FMODE=screen
      printf '\n\033[1;31mdev3: saving input failed after %s bytes (%s); the rest is SHOWN here, not saved, not run\033[0m\n' "$__DEV3_FSAVED" "$__DEV3_FTMP"
    fi
    __DEV3_FSHOWN=$((__DEV3_FSHOWN + __dev3_k))
    printf "$(printf '%s' "$1" | sed 's/ *\([0-7][0-7][0-7]\)/\\\1/g')" | od -An -v -c
  }
  __dev3_read() {
    __dev3_h=$(dd bs=4096 count=1 2>/dev/null | od -An -v -to1 | tr -s ' \n' '  ' | sed 's/ *$//')
    __DEV3_FLAST=${"$"}{#__dev3_h}
    [ -n "$__dev3_h" ] || return 0
    __dev3_b=$(printf ' %s %s' "$__DEV3_FTAIL" "$__dev3_h" | tr -s ' ')
    __DEV3_FSEEN="$__DEV3_FSEEN$(printf '%s' "$__dev3_b" | grep -oE "$__DEV3_FSP( [0-7]{3}){16} 037" | tr '\n' '|')"
    __dev3_b=$(printf '%s' "$__dev3_b" | sed -E "s/$__DEV3_FSP( [0-7]{3}){16} 037//g")
    __DEV3_FTAIL=$(printf '%s' "$__dev3_b" | grep -oE '( [0-7]{3}){1,28}$')
    __dev3_emit "${"$"}{__dev3_b%"$__DEV3_FTAIL"}"
    [ -n "$__DEV3_FWANT" ] && __dev3_want "$(printf '%s' "$__DEV3_FWANT" | sed 's/|.*//')"
    return 0
  }
  __dev3_own_close() {
    __dev3_n=$(__dev3_nonce)
    __dev3_out=$(__dev3_tmux set-buffer -b "dev3-fence-$__dev3_n" -- "$(printf '\037dev3-fence:%s\037' "$__dev3_n")" \; \
      if-shell -t "$TMUX_PANE" -F "#{==:#{@dev3_agent_input},open:$__DEV3_FLAUNCH}" \
      "set-option -p -t $TMUX_PANE @dev3_agent_input closed:$__DEV3_FLAUNCH:$1 ; set-option -p -t $TMUX_PANE @dev3_fence_nonce $__dev3_n ; paste-buffer -d -r -b dev3-fence-$__dev3_n -t $TMUX_PANE" \; \
      display-message -p -t "$TMUX_PANE" "dev3-agent-fence:#{@dev3_agent_input} #{@dev3_fence_nonce}") || return 1
    __dev3_tmux delete-buffer -b "dev3-fence-$__dev3_n"
    __dev3_v=$(printf '%s\n' "$__dev3_out" | sed -n 's/^dev3-agent-fence:\([^ ]*\) .*/\1/p')
    __dev3_sn=$(printf '%s\n' "$__dev3_out" | sed -n 's/^dev3-agent-fence:[^ ]* //p')
    case "$__dev3_v" in "closed:$__DEV3_FLAUNCH:"*) ;; *) return 1;; esac
    printf '%s' "$__dev3_sn" | grep -Eq '^[0-9a-f]{16}$' || return 1
    __dev3_want "$__DEV3_FSP $(__dev3_oct "$__dev3_sn") 037"
  }
  __dev3_request() {
    { mkdir -p "$__DEV3_FINDEX" && __dev3_t=$(mktemp "$__DEV3_FINDEX/.req.XXXXXX") &&
      printf '%s %s %s %s %s\n' "$__DEV3_FLAUNCH" "$TMUX_PANE" "${"$"}{TMUX%%,*}" "$1" "$__DEV3_FTASK" >"$__dev3_t" &&
      mv "$__dev3_t" "$__DEV3_FINDEX/$__DEV3_FLAUNCH.close"; } 2>/dev/null
  }
  __dev3_read_ack() {
    [ -e "$__DEV3_FINDEX/$__DEV3_FLAUNCH.closed-ack" ] || return 1
    __dev3_a=$(cat "$__DEV3_FINDEX/$__DEV3_FLAUNCH.closed-ack" 2>/dev/null) || return 1
    __dev3_id=${"$"}{__dev3_a%% *}; __dev3_rest=${"$"}{__dev3_a#* }; __dev3_v=${"$"}{__dev3_rest%% *}; __dev3_an=${"$"}{__dev3_rest#* }
    [ "$__dev3_id" = "$__DEV3_FLAUNCH" ] || return 1
    case "$__dev3_v" in "closed:$__DEV3_FLAUNCH:"*) ;; *) return 1;; esac
    printf '%s' "$__dev3_an" | grep -Eq '^[0-9a-f]{16}$' || return 1
    __dev3_want "$__DEV3_FSP $(__dev3_oct "$__dev3_an") 037"
  }
  if ! __dev3_own_close "$__EXITVAR__"; then
    __dev3_request "$__EXITVAR__" && __dev3_asked=1 || __dev3_asked=0
    printf '\n\033[1;31mdev3: could not close the delivery fence of this pane, so no shell starts yet.\033[0m\n'
    if [ "$__dev3_asked" = 1 ]; then printf 'dev3: waiting for the dev3 app to close it. Anything typed here is saved, never run.\n'
    else printf 'dev3: could not ask the app either (%s unwritable). Anything typed here is saved, never run.\n' "$__DEV3_FINDEX"; fi
    printf 'dev3: to get a shell now, close this pane and open a new one.\n'
  fi
  __dev3_i=0; __dev3_said=0; __dev3_idle=0; __dev3_slow=0; __dev3_every=15
  while [ "$__DEV3_FBARRIER" = 0 ]; do
    __dev3_read
    __dev3_read_ack
    __dev3_i=$((__dev3_i + 1))
    # A pane left blocked for hours must not fork ~15 processes a second: after ~6 s of
    # silence wake every 3 s instead of every 0.3 s, and go back on any byte or a close.
    if [ "$__DEV3_FLAST" = 0 ]; then __dev3_idle=$((__dev3_idle + 1)); else __dev3_idle=0; fi
    if [ "$__dev3_slow" = 0 ] && [ -z "$__DEV3_FWANT" ] && [ "$__dev3_idle" -ge 20 ] && [ -n "$__DEV3_FTTY" ]; then
      stty time 30 2>/dev/null; __dev3_slow=1; __dev3_every=2
    elif [ "$__dev3_slow" = 1 ] && { [ "$__dev3_idle" = 0 ] || [ -n "$__DEV3_FWANT" ]; }; then
      stty time 3 2>/dev/null; __dev3_slow=0; __dev3_every=15
    fi
    if [ -z "$__DEV3_FWANT" ] && [ $((__dev3_i % __dev3_every)) = 0 ]; then
      __dev3_own_close "$__EXITVAR__" || { [ -e "$__DEV3_FINDEX/$__DEV3_FLAUNCH.close" ] || __dev3_request "$__EXITVAR__"; }
    fi
    if [ -n "$__DEV3_FWANT" ] && [ "$__dev3_said" = 0 ] && [ "$__dev3_i" -gt 20 ]; then
      printf 'dev3: fence closed; waiting for its barrier before starting the shell.\n'; __dev3_said=1
    fi
  done
  while :; do __dev3_read; [ "$__DEV3_FLAST" = 0 ] && break; done
  __dev3_emit "$__DEV3_FTAIL"; __DEV3_FTAIL=""
  [ -n "$__DEV3_FTTY" ] && stty "$__DEV3_FTTY" 2>/dev/null
  if [ "$__DEV3_FSAVED" -gt 0 ]; then
    __dev3_dest="$__DEV3_FRACED/raced-$(date +%Y%m%dT%H%M%S)-$$.txt"
    { mkdir -p "$__DEV3_FRACED" && mv "$__DEV3_FTMP" "$__dev3_dest"; } 2>/dev/null || __dev3_dest=$__DEV3_FTMP
    printf '\n\033[1;33mdev3: %s byte(s) typed into this pane after the agent exited (your own keystrokes included) were saved, not run: %s\033[0m\n' "$__DEV3_FSAVED" "$__dev3_dest"
  elif [ -n "$__DEV3_FTMP" ]; then rm -f "$__DEV3_FTMP" 2>/dev/null; fi
  [ "$__DEV3_FSHOWN" -gt 0 ] && printf '\033[1;31mdev3: %s byte(s) could NOT be saved; they were shown above, not run\033[0m\n' "$__DEV3_FSHOWN"
  [ "$__DEV3_FDROP" -gt 0 ] && printf '\033[1;31mdev3: %s byte(s) past the limit were DISCARDED, not run\033[0m\n' "$__DEV3_FDROP"
  rm -f "$__DEV3_FINDEX/$__DEV3_FLAUNCH.close" 2>/dev/null && rm -f "$__DEV3_FINDEX/$__DEV3_FLAUNCH.closed-ack" 2>/dev/null
fi
trap - INT QUIT TSTP`;
