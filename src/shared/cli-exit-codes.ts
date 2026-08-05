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
			"An agent asked to start another task (`dev3 task move --task <other> --status in-progress`, or `dev3 task create --scratch --run`) and the user declined the approval dialog. Nothing was launched and the target task stays where it was.",
	},
	{
		constant: "CLI_EXIT_CODE_DELIVERY_UNCONFIRMED",
		code: CLI_EXIT_CODE_DELIVERY_UNCONFIRMED,
		description:
			"`dev3 message` sent the text but no backend could confirm it arrived (the native terminal host cannot acknowledge input, or a tmux send stopped mid-program). The message may well have landed, so DO NOT re-send it — a re-send is a second submit into a live agent. Distinct from exit 1, which means nothing was sent.",
	},
] as const;
