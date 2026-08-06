# CLI Exit Codes

Public `dev3` CLI exit codes are defined in `src/shared/cli-exit-codes.ts`.

| Code | Constant | Meaning |
| --- | --- | --- |
| `0` | `CLI_EXIT_CODE_SUCCESS` | Command completed successfully, or exited intentionally without an error (`--help`, `--version`). |
| `1` | `CLI_EXIT_CODE_COMMAND_FAILED` | A handled command failure occurred after parsing succeeded. |
| `2` | `CLI_EXIT_CODE_APP_NOT_RUNNING` | The desktop app or CLI socket was unavailable for a command that requires it. |
| `3` | `CLI_EXIT_CODE_USAGE_ERROR` | The CLI invocation was invalid: bad command, bad subcommand, or missing required args. |
| `4` | `CLI_EXIT_CODE_INTERNAL_ERROR` | An unexpected internal CLI failure escaped normal command handling. |
| `5` | `CLI_EXIT_CODE_GUI_DEPS_MISSING` | `dev3 gui` cannot launch because system libraries (GTK, WebKit, etc.) are missing. The CLI prints the install command for the detected distro and exits with this code so wrappers can detect it. |
| `6` | `CLI_EXIT_CODE_COMPLETION_DECLINED` | `dev3 task move --status completed` asked the user for approval and the user declined. The task keeps its current status and the session stays alive. |
| `7` | `CLI_EXIT_CODE_DOCTOR_PROBLEMS` | `dev3 doctor` found at least one problem (a check with status "fail"). Warnings alone still exit 0. |
| `8` | `CLI_EXIT_CODE_RENDERER_UNAVAILABLE` | The desktop launch created a window but no renderer ever reported dom-ready within the readiness budget — a missing or broken WebView2 runtime, or no interactive desktop (SSH / session 0). The process prints an actionable diagnostic and leaves instead of running without a UI. |
| `9` | `CLI_EXIT_CODE_TASK_IS_DRAFT` | `dev3 task move` was asked to start a task the user saved as a draft. A draft is deliberately unfinished, so no launch path may start it — the human must finish its description and save it as a normal task first. |
| `10` | `CLI_EXIT_CODE_LAUNCH_DECLINED` | An agent asked to start another task (`dev3 task move --task <other> --status in-progress`, or `dev3 task create --scratch --run`) and the user declined the approval dialog. Nothing was launched and the target task stays where it was. |
| `11` | `CLI_EXIT_CODE_DELIVERY_UNCONFIRMED` | `dev3 message` sent the text but no backend could confirm it arrived — the native terminal host cannot acknowledge input yet, or a tmux send stopped mid-program. The message may well have landed, so **do not re-send it**: a re-send is a second submit into a live agent. Distinct from code `1`, which means nothing was sent. |
| `12` | `CLI_EXIT_CODE_PRUNE_INCOMPLETE` | `dev3 doctor --worktrees` was asked to prune and at least one selected directory was **not** reclaimed: skipped because its `dev3/task-*` branch is not merged into the base branch and `--force-unmerged` was absent, or the deletion itself failed. Everything else in the run was still deleted. A report-only run always exits `0`. |

`--tolerate-app-offline` turns code `2` into code `0` for a single invocation: the
"app not running" notice is still written to stderr, but the process exits
successfully. Generated agent hooks pass it on platforms whose hook runner has no
POSIX shell (Windows) and therefore cannot collapse the code themselves. Every
other failure code is unaffected.

Rules:

- Every non-zero public `dev3` CLI exit code must be unique.
- Add or change codes only in `src/shared/cli-exit-codes.ts`.
- Keep this file and `src/cli/__tests__/exit-codes.test.ts` in sync with the registry.
