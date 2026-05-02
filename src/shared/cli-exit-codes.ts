export const CLI_EXIT_CODE_SUCCESS = 0;
export const CLI_EXIT_CODE_COMMAND_FAILED = 1;
export const CLI_EXIT_CODE_APP_NOT_RUNNING = 2;
export const CLI_EXIT_CODE_USAGE_ERROR = 3;
export const CLI_EXIT_CODE_INTERNAL_ERROR = 4;
export const CLI_EXIT_CODE_GUI_DEPS_MISSING = 5;

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
] as const;
