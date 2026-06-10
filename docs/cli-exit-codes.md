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

Rules:

- Every non-zero public `dev3` CLI exit code must be unique.
- Add or change codes only in `src/shared/cli-exit-codes.ts`.
- Keep this file and `src/cli/__tests__/exit-codes.test.ts` in sync with the registry.
