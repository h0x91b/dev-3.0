export const CLI_EXIT_CODE_SUCCESS = 0;
export const CLI_EXIT_CODE_COMMAND_FAILED = 1;
export const CLI_EXIT_CODE_APP_NOT_RUNNING = 2;
export const CLI_EXIT_CODE_USAGE_ERROR = 3;
export const CLI_EXIT_CODE_INTERNAL_ERROR = 4;
export const CLI_EXIT_CODE_GUI_DEPS_MISSING = 5;
export const CLI_EXIT_CODE_COMPLETION_DECLINED = 6;
export const CLI_EXIT_CODE_DOCTOR_PROBLEMS = 7;
export const CLI_EXIT_CODE_RENDERER_UNAVAILABLE = 8;
export const CLI_EXIT_CODE_TASK_IS_DRAFT = 9;
export const CLI_EXIT_CODE_LAUNCH_DECLINED = 10;
export const CLI_EXIT_CODE_DELIVERY_UNCONFIRMED = 11;
export const CLI_EXIT_CODE_PRUNE_INCOMPLETE = 12;
export const CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING = 13;
export const CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND = 14;
export const CLI_EXIT_CODE_UPDATE_REFUSED = 15;
export const CLI_EXIT_CODE_INSTANCE_NOT_FOUND = 16;
export const CLI_EXIT_CODE_MESSAGE_SUBJECT_REQUIRED = 17;
export const CLI_EXIT_CODE_TASK_REF_UNRESOLVED = 18;
export const CLI_EXIT_CODE_EVENT_CURSOR_INVALID = 19;
export const CLI_EXIT_CODE_NO_PROJECT_FOR_CWD = 20;
export const CLI_EXIT_CODE_DEV_SERVER_ENV_INVALID = 21;
export const CLI_EXIT_CODE_CANCELLATION_DECLINED = 22;
export const CLI_EXIT_CODE_GH_UNAVAILABLE = 23;
export const CLI_EXIT_CODE_DEV_SERVER_NAME_REQUIRED = 24;
export const CLI_EXIT_CODE_APPROVAL_STILL_PENDING = 25;
export const CLI_EXIT_CODE_APPROVAL_OUTCOME_UNKNOWN = 26;
export const CLI_EXIT_CODE_RESET_DECLINED = 27;
export const CLI_EXIT_CODE_GH_TLS_UNVERIFIED = 28;
export const CLI_EXIT_CODE_PEEK_FOLLOW_UNSUPPORTED = 29;
export const CLI_EXIT_CODE_PANE_NO_ROOM = 30;
export const CLI_EXIT_CODE_RESUME_ALREADY_RUNNING = 31;
export const CLI_EXIT_CODE_RESUME_UNAVAILABLE = 32;
export const CLI_EXIT_CODE_PROJECT_ALREADY_REGISTERED = 33;
export const CLI_EXIT_CODE_SPACE_REF_INVALID = 34;
export const CLI_EXIT_CODE_HIBERNATE_NOTHING_TO_FREE = 35;
export const CLI_EXIT_CODE_HIBERNATE_DECLINED = 36;
export const CLI_EXIT_CODE_TASK_NOT_HIBERNATED = 37;
export const CLI_EXIT_CODE_PR_WATCH_NO_PR = 38;
export const CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN = 39;
export const CLI_EXIT_CODE_SENDER_INBOX_BUSY = 40;
export const CLI_EXIT_CODE_LIVE_REV_CONFLICT = 41;
export const CLI_EXIT_CODE_LIVE_READ_ONLY = 42;

export const CLI_EXIT_CODE_DEFINITIONS = [
	{
		constant: "CLI_EXIT_CODE_SUCCESS",
		code: CLI_EXIT_CODE_SUCCESS,
		description: "Command completed successfully, or exited intentionally without an error.",
	},
	{
		constant: "CLI_EXIT_CODE_COMMAND_FAILED",
		code: CLI_EXIT_CODE_COMMAND_FAILED,
		description: "A handled command failure occurred after parsing succeeded.",
	},
	{
		constant: "CLI_EXIT_CODE_APP_NOT_RUNNING",
		code: CLI_EXIT_CODE_APP_NOT_RUNNING,
		description: "The desktop app or CLI socket was unavailable for a command that requires it.",
	},
	{
		constant: "CLI_EXIT_CODE_USAGE_ERROR",
		code: CLI_EXIT_CODE_USAGE_ERROR,
		description: "The CLI invocation was invalid: bad command, bad subcommand, or missing required args.",
	},
	{
		constant: "CLI_EXIT_CODE_INTERNAL_ERROR",
		code: CLI_EXIT_CODE_INTERNAL_ERROR,
		description: "An unexpected internal CLI failure escaped normal command handling.",
	},
	{
		constant: "CLI_EXIT_CODE_GUI_DEPS_MISSING",
		code: CLI_EXIT_CODE_GUI_DEPS_MISSING,
		description:
			"`dev3 gui` cannot launch because system libraries (GTK, WebKit, etc.) are missing. The CLI prints the install command for the detected distro and exits with this code so wrappers can detect it.",
	},
	{
		constant: "CLI_EXIT_CODE_COMPLETION_DECLINED",
		code: CLI_EXIT_CODE_COMPLETION_DECLINED,
		description:
			"`dev3 task move --status completed` asked the user for approval and the user declined. The task keeps its current status and the session stays alive.",
	},
	{
		constant: "CLI_EXIT_CODE_DOCTOR_PROBLEMS",
		code: CLI_EXIT_CODE_DOCTOR_PROBLEMS,
		description:
			'`dev3 doctor` found at least one problem (a check with status "fail"). Warnings alone still exit 0.',
	},
	{
		constant: "CLI_EXIT_CODE_RENDERER_UNAVAILABLE",
		code: CLI_EXIT_CODE_RENDERER_UNAVAILABLE,
		description:
			"The desktop launch created a window but no renderer ever reported dom-ready within the readiness budget (missing/broken WebView2 runtime, or no interactive desktop). The process prints an actionable diagnostic and leaves instead of running without a UI.",
	},
	{
		constant: "CLI_EXIT_CODE_TASK_IS_DRAFT",
		code: CLI_EXIT_CODE_TASK_IS_DRAFT,
		description:
			"`dev3 task move` was asked to start a task the user saved as a draft. A draft is deliberately unfinished, so no launch path may start it — the human must finish its description and save it as a normal task first.",
	},
	{
		constant: "CLI_EXIT_CODE_LAUNCH_DECLINED",
		code: CLI_EXIT_CODE_LAUNCH_DECLINED,
		description:
			"An agent asked to start another task (`dev3 task move --task <other> --status in-progress`, or `dev3 task create --scratch --run`), to add an agent (`dev3 agent spawn`) or to resume a saved session (`dev3 agent resume`), and the user declined the approval dialog — or, for spawn and resume, the target task's run ended before anyone answered. Nothing was launched and the target task stays where it was.",
	},
	{
		constant: "CLI_EXIT_CODE_DELIVERY_UNCONFIRMED",
		code: CLI_EXIT_CODE_DELIVERY_UNCONFIRMED,
		description:
			"`dev3 message` sent the text but no backend could confirm it arrived (the native terminal host cannot acknowledge input, or a tmux send stopped mid-program), or any `dev3 message` form (immediate, `--in`/`--at`, `--to-sender`) lost its connection to the app after the request was sent (reset, broken pipe, empty or unreadable response, timeout). The message may well have landed, so DO NOT re-send it — a re-send is a second submit into a live agent. Distinct from exit 1, which means nothing was sent.",
	},
	{
		constant: "CLI_EXIT_CODE_PRUNE_INCOMPLETE",
		code: CLI_EXIT_CODE_PRUNE_INCOMPLETE,
		description:
			"`dev3 doctor --worktrees` was asked to prune and at least one selected directory was NOT reclaimed: it was skipped (its `dev3/task-*` branch is not merged into the base branch and `--force-unmerged` was absent) or the deletion failed. Everything else in the run was still deleted. A report-only run always exits 0.",
	},
	{
		constant: "CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING",
		code: CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING,
		description:
			"`dev3 inline-html` found a local file the HTML references but that does not exist on disk, so the folded page would render broken. Nothing was written; the JSON report lists every missing reference.",
	},
	{
		constant: "CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND",
		code: CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND,
		description:
			"`dev3 inline-html` found a credential-shaped string (GitHub token, `sk-` key, AWS key id, private-key block) inside the folded page. Nothing was written and the file must not be published until the secret is removed.",
	},
	{
		constant: "CLI_EXIT_CODE_UPDATE_REFUSED",
		code: CLI_EXIT_CODE_UPDATE_REFUSED,
		description:
			"`dev3 update` refused to touch this install and nothing was changed: it is running from source, it is one of the copies dev3 keeps inside `~/.dev3.0` rather than an install — the PATH copy at `<dev3Home>/bin/dev3` that the app rewrites on every launch, or the `remote/rollback/dev3` copy a self-update took aside and a rolled-back server runs from (updating either would write a release tree into dev3's own data directory and leave the real install stale), it is a macOS app bundle the CLI cannot swap, it is Windows (no CLI tarball), or it is a Homebrew cask whose recorded version has drifted from the running one. Distinct from exit 1, which means an update was attempted and failed.",
	},
	{
		constant: "CLI_EXIT_CODE_INSTANCE_NOT_FOUND",
		code: CLI_EXIT_CODE_INSTANCE_NOT_FOUND,
		description:
			"`--instance <selector>` was well-formed but no running instance answers to it — or more than one does (a `seq:<N>` shared by variants, or a `task:` prefix matching two guests). The message lists what IS running. Distinct from exit 2, which means no instance is reachable at all, and from exit 3, which means the selector itself was misspelled. The command never falls back to another instance.",
	},
	{
		constant: "CLI_EXIT_CODE_MESSAGE_SUBJECT_REQUIRED",
		code: CLI_EXIT_CODE_MESSAGE_SUBJECT_REQUIRED,
		description:
			"`dev3 message` was called without a usable `--subject`, or with one over the character limit. Nothing was sent and nothing was queued. Every message carries a one-line subject: it is stored with the message and it is the line the agent-traffic view shows, so it can be neither defaulted nor derived. The error prints the limit, a good and a bad example, and the corrected command. An over-limit subject is rejected, never truncated. Distinct from exit 3 so automation can recognise this one case and retry with a subject instead of treating it as a misspelled command.",
	},
	{
		constant: "CLI_EXIT_CODE_TASK_REF_UNRESOLVED",
		code: CLI_EXIT_CODE_TASK_REF_UNRESOLVED,
		description:
			"`dev3 task create --pr <n>` or `--branch <ref>` could not resolve what the task is about, so NOTHING was created: no such pull request, no such ref, the pull request's fork could not be fetched, `gh` is missing or unauthenticated, or the project is not a GitHub repo. The task is not created half-right on the base branch — fix the argument and run it again. Distinct from exit 1, which means the task itself failed to be created.",
	},
	{
		constant: "CLI_EXIT_CODE_EVENT_CURSOR_INVALID",
		code: CLI_EXIT_CODE_EVENT_CURSOR_INVALID,
		description:
			"`dev3 events --from <cursor>` was given a cursor it cannot parse, and NOTHING was read. Four shapes are accepted: an event id from the ID column (`8eb2da3d`, or an unambiguous prefix), a cursor as printed by a previous run (`2026-08-29T10:12:03.114`), a plain date or instant for a deliberately wider sweep, and a duration such as `2h`. The same code covers an id that resolves to nothing or to more than one event — a lost id must never be answered with 'nothing since then', which reads as a quiet board. Distinct from exit 3 so a caller that lost its cursor can recognise this one case and fall back to a bare `dev3 events` instead of treating it as a misspelled command. Never silently degraded into a time window — a cursor that quietly becomes 'the last day' skips everything older and reports success.",
	},
	{
		constant: "CLI_EXIT_CODE_NO_PROJECT_FOR_CWD",
		code: CLI_EXIT_CODE_NO_PROJECT_FOR_CWD,
		description:
			"`dev3 import` was run in a directory no registered dev3 project owns. A conversation can only be imported into the project that owns the directory it ran in, so the project has to be added to the board first — there is deliberately no flag to import it somewhere else. The message names the directory checked, and says something more useful than 'add the repository' for the two directories agents actually live in: a dev3 worktree (whose conversation is already a task) and a virtual board's working dir (which has no repository at all).",
	},
	{
		constant: "CLI_EXIT_CODE_DEV_SERVER_ENV_INVALID",
		code: CLI_EXIT_CODE_DEV_SERVER_ENV_INVALID,
		description:
			"`dev3 dev-server start --env` / `restart --env` was given something it will not pass to the devScript, and NOTHING was started or restarted: an argument that is not `KEY=VALUE`, a key that is not a valid environment variable name, or one of the names dev3 owns (`PATH`, `HOME`, `SHELL`, `DEV3_TASK_ID`, `DEV3_WORKTREE_ROOT`, any `DEV3_PORT*`). A silently dropped pair is worse than a refusal — the server would come up on the wrong configuration and look correct. Distinct from exit 3 so a caller can tell a rejected variable from a misspelled command.",
	},
	{
		constant: "CLI_EXIT_CODE_CANCELLATION_DECLINED",
		code: CLI_EXIT_CODE_CANCELLATION_DECLINED,
		description:
			"`dev3 task move --status cancelled` asked the user for approval and the user declined. The task keeps its current status and the session stays alive. Distinct from exit 6 so an agent cleaning up after itself can tell a refused cancellation apart from a refused completion — the two ask for very different things, and only cancellation throws the work away.",
	},
	{
		constant: "CLI_EXIT_CODE_GH_UNAVAILABLE",
		code: CLI_EXIT_CODE_GH_UNAVAILABLE,
		description:
			"A `dev3 pr` subcommand (`create`, `auto-merge`) found no usable GitHub CLI: `gh` is not installed, or it is installed but not authenticated. NOTHING was pushed and no pull request was opened or changed — the check runs before the push precisely so a logged-out `gh` cannot be discovered halfway through. Distinct from exit 1, which means the push or `gh pr create` itself failed.",
	},
	{
		constant: "CLI_EXIT_CODE_DEV_SERVER_NAME_REQUIRED",
		code: CLI_EXIT_CODE_DEV_SERVER_NAME_REQUIRED,
		description:
			"`dev3 dev-server start|stop|restart` was called without naming a dev server on a project that declares several and has no default (no `devScript`), so NOTHING was started, stopped or restarted — there is no safe way to guess which process the caller meant. The message lists the declared names; pass one of them, or `--all` to act on every one. Distinct from exit 3 so automation can recognise this one case and retry with a name instead of treating it as a misspelled command.",
	},
	{
		constant: "CLI_EXIT_CODE_APPROVAL_STILL_PENDING",
		code: CLI_EXIT_CODE_APPROVAL_STILL_PENDING,
		description:
			"`dev3 task move --status completed|cancelled|todo` (todo = a reset) stopped waiting and the app confirms the request is STILL PENDING: the ten-minute wait ran out, or the connection dropped and came back after the wait was already spent. The dialog is still open and an answer will still take effect. Running the same command again waits on that same request — it does not open a second dialog. Distinct from exit 1 so an agent never reads 'still waiting' as 'failed' and asks anew.",
	},
	{
		constant: "CLI_EXIT_CODE_APPROVAL_OUTCOME_UNKNOWN",
		code: CLI_EXIT_CODE_APPROVAL_OUTCOME_UNKNOWN,
		description:
			"`dev3 task move --status completed|cancelled|todo` (todo = a reset) lost its connection mid-wait and cannot say how the request ended: the app has no record of it (it restarted, the record aged out, or the request never arrived) and the task has not moved to the target status — or the app could not be reached again at all. This is NOT evidence of a decline, nor that nothing was approved. Asking again opens a new dialog, so check the task and the user first.",
	},
	{
		constant: "CLI_EXIT_CODE_RESET_DECLINED",
		code: CLI_EXIT_CODE_RESET_DECLINED,
		description:
			"`dev3 task move --status todo` on a task that needs a reset (it is active or still owns a worktree) asked the user for approval and it was NOT granted: the user declined, or the task's run ended before anyone answered (the request is then voided, never approved). This request stopped or deleted NOTHING. After a decline the task keeps its status, worktree and session; after a void, whatever ended the run (a completion, cancellation or another reset) may have removed its worktree. Distinct from exits 6 and 22: a reset keeps the card but throws the run away, and an agent must be able to tell that refusal apart from a refused completion or cancellation.",
	},
	{
		constant: "CLI_EXIT_CODE_GH_TLS_UNVERIFIED",
		code: CLI_EXIT_CODE_GH_TLS_UNVERIFIED,
		description:
			"A `dev3 pr` subcommand (`create`, `auto-merge`) found `gh` unable to verify GitHub's TLS certificate, so NOTHING was pushed and no pull request was opened or changed. This is NOT a credential failure: do not re-run `gh auth login` or switch accounts. `x509: OSStatus -26276` on macOS means an agent sandbox blocks the trustd check Go programs such as gh rely on (curl and git are unaffected); the remedy is the user's call — approving that one command outside the sandbox through the agent's own permission prompt, or opting into Claude Code's `sandbox.enableWeakerNetworkIsolation` at its documented security cost. Any other certificate error points at a proxy or custom CA. Distinct from exit 23 so an agent never answers a blocked TLS check with a login prompt.",
	},
	{
		constant: "CLI_EXIT_CODE_PEEK_FOLLOW_UNSUPPORTED",
		code: CLI_EXIT_CODE_PEEK_FOLLOW_UNSUPPORTED,
		description:
			"`dev3 peek --follow` was aimed at a pane whose backend publishes no screen text (the native backend answers `not-enabled` today). The one snapshot it could take — pane summary plus the explicit `could not read the terminal` line — is printed first, then the follow ends instead of sampling a screen it can never read. Distinct from code `1` so a watcher can tell \"this backend cannot be followed\" from a failed request.",
	},
	{
		constant: "CLI_EXIT_CODE_PANE_NO_ROOM",
		code: CLI_EXIT_CODE_PANE_NO_ROOM,
		description:
			"`dev3 pane run` on the native terminal backend (the only one on Windows) found no pane it could split without leaving one below the usable minimum (40 columns by 8 rows), so NOTHING was opened and nothing on screen changed. The protected main pane is never split again to make room; tmux tasks never get this code, because there the run opens in a new `Runs` window instead. Close a finished run (`dev3 pane close <run-id>`), enlarge the window, or run the command inline. Distinct from exit 1 so an agent can fall back to running the command itself instead of retrying.",
	},
	{
		constant: "CLI_EXIT_CODE_RESUME_ALREADY_RUNNING",
		code: CLI_EXIT_CODE_RESUME_ALREADY_RUNNING,
		description:
			"`dev3 agent resume` found the task's terminal already running, so NOTHING was resumed, restarted or torn down — the live session is left exactly as it was. With `--json` the result still names the backend. Use `dev3 peek` to look at it or `dev3 agent spawn` to add an agent. Distinct from exit 1 so a coordinator recovering many tasks can treat this one as already done.",
	},
	{
		constant: "CLI_EXIT_CODE_RESUME_UNAVAILABLE",
		code: CLI_EXIT_CODE_RESUME_UNAVAILABLE,
		description:
			"`dev3 agent resume` found nothing it can safely resume, and NOTHING was launched: the task is a draft or not active, it has no worktree, it has no saved agent session, a saved pane runs an agent CLI dev3 cannot resume (it would start over from the task description; `--allow-agent-latest` does not change that), or (without `--allow-agent-latest`) a saved pane has no conversation id, so its harness would pick its own latest conversation and might start a new one. With `--json` the result carries a `reason` (`draft`, `not-active`, `no-worktree`, `no-saved-session`, `harness-cannot-resume`, `session-id-unknown`). It never re-runs the task description; Start Fresh stays an explicit choice in the app. The one pane that does open a new, empty conversation is reported as `fresh-session`: nothing of its own survives and every transcript belongs to another pane, so reopening any of them would duplicate it. Distinct from exit 1, which means a resume was attempted and failed.",
	},
	{
		constant: "CLI_EXIT_CODE_PROJECT_ALREADY_REGISTERED",
		code: CLI_EXIT_CODE_PROJECT_ALREADY_REGISTERED,
		description:
			"`dev3 projects add` or `dev3 projects clone` found the folder already registered as a project (compared with symlinks resolved), so NOTHING changed: no project was added, nothing was cloned, and its spaces were left as they are even when `--space` / `--new-space` / `--no-space` was passed. The existing project is printed — with `--json` as the usual result object, `outcome` = `exists` — so a script can take its id and carry on; change its spaces with `dev3 spaces set|add|remove --project <id>`. Distinct from exit 1 so registering a repo can be treated as idempotent.",
	},
	{
		constant: "CLI_EXIT_CODE_SPACE_REF_INVALID",
		code: CLI_EXIT_CODE_SPACE_REF_INVALID,
		description:
			"A `dev3 projects add|clone` or `dev3 spaces …` command named a space it cannot use, so NOTHING was added, cloned, created or changed: a `--space` / positional space matched no space or more than one (a name two spaces share — pass the id), or `--new-space` / `spaces create` named a space that already exists (names compare case-insensitively). The message lists the existing spaces with their ids. Distinct from exit 1 so a caller can fall back to creating the space (`--new-space`, `dev3 spaces create`) or to joining the existing one, instead of treating it as a failed registration.",
	},
	{
		constant: "CLI_EXIT_CODE_HIBERNATE_NOTHING_TO_FREE",
		code: CLI_EXIT_CODE_HIBERNATE_NOTHING_TO_FREE,
		description:
			"`dev3 task hibernate` found nothing running to free, so NOTHING was stopped: the task is already hibernated, a draft, not in an active column, has no worktree, or has no live terminal. With `--json` the result carries a `reason` (`already-hibernated`, `draft`, `not-active`, `no-worktree`, `not-running`). A task whose terminal is gone after a restart can be brought back with `dev3 agent resume`. Distinct from exit 1 so a coordinator parking many tasks can treat an already-parked one as done.",
	},
	{
		constant: "CLI_EXIT_CODE_HIBERNATE_DECLINED",
		code: CLI_EXIT_CODE_HIBERNATE_DECLINED,
		description:
			"`dev3 task hibernate` was run from inside a task (an agent asked) and the user did NOT approve it in the app: they declined, or the task's run ended before anyone answered. NOTHING was stopped — the agent, terminal and dev server keep running. An unanswered dialog approves itself after the configured launch auto-approval delay, so this code always means a human said no, or the run was gone. Distinct from exit 10, which a declined launch, resume or plain-shell wake returns.",
	},
	{
		constant: "CLI_EXIT_CODE_TASK_NOT_HIBERNATED",
		code: CLI_EXIT_CODE_TASK_NOT_HIBERNATED,
		description:
			"`dev3 task wake` was aimed at a task that is not hibernated, so NOTHING was launched or changed. A live task needs no wake; a task whose terminal died without being hibernated is resumed with `dev3 agent resume`. Distinct from exit 1 so a coordinator waking several tasks can treat an already-awake one as done.",
	},
	{
		constant: "CLI_EXIT_CODE_PR_WATCH_NO_PR",
		code: CLI_EXIT_CODE_PR_WATCH_NO_PR,
		description:
			"`dev3 pr watch` found no pull request to watch, so NOTHING was subscribed: the task's branch has no open PR (or GitHub did not answer in time), or `--pr <N>` is not that open PR. Watching follows the open PR of the task's own branch only; a review target is not supported. Open the PR first (`dev3 pr create`), then run it again. Distinct from exit 1 so an agent that opened a PR a moment ago can retry once GitHub lists it instead of treating this as a failed command.",
	},
	{
		constant: "CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN",
		code: CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN,
		description:
			"`--as-sender <id>` or `--to-sender <id>` named an external sender that is not registered in `~/.dev3.0/external-senders.json`, so NOTHING was sent, written or started. Senders are added by hand to that file (`{\"senders\": {\"<id>\": {\"label\": \"…\"}}}`); the app never writes it. Distinct from exit 1 so a sender can tell \"I am not registered\" from a failed send.",
	},
	{
		constant: "CLI_EXIT_CODE_SENDER_INBOX_BUSY",
		code: CLI_EXIT_CODE_SENDER_INBOX_BUSY,
		description:
			"`dev3 sender inbox --client <cid>` or `dev3 sender ack` found another client holding that sender's reader lease, so NOTHING was read into a lease or acknowledged. The lease lapses 10 s after its holder's last wait. Do not take it over automatically: `--take-over` is for a person who knows the other reader is gone. Distinct from exit 1 so a second reader can back off instead of retrying in a loop.",
	},
	{
		constant: "CLI_EXIT_CODE_LIVE_REV_CONFLICT",
		code: CLI_EXIT_CODE_LIVE_REV_CONFLICT,
		description:
			"`dev3 live set|patch|delete --if-rev <n>` found the document at a different revision than the one passed (someone — usually the user on the live page — changed it since it was read), so NOTHING was written. The message names the current revision; re-read the document with `dev3 live get`, merge, and retry. Distinct from exit 1 so an agent can tell a lost race from a failed write.",
	},
	{
		constant: "CLI_EXIT_CODE_LIVE_READ_ONLY",
		code: CLI_EXIT_CODE_LIVE_READ_ONLY,
		description:
			"A `dev3 live` write (`publish`, `adopt`, `set`, `patch`, `delete`, `clear`) targeted a task that is completed or cancelled, so NOTHING changed: a finished task's live artifact is kept read-only, with its page and data still readable through `dev3 live status|get|list|events`. Distinct from exit 1 so an agent does not retry a write that can never succeed.",
	},
] as const;
