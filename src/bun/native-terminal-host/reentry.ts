function isBunExecutable(execPath: string): boolean {
	const parts = execPath.replaceAll("\\", "/").split("/");
	const name = parts[parts.length - 1]?.toLowerCase();
	return name === "bun" || name === "bun.exe";
}


export function computeTerminalHostReentryArgs(
	argv: string[],
	execPath: string,
	stagedEntrypoint?: string,
): string[] {
	if (stagedEntrypoint) return [stagedEntrypoint, "__host"];
	return isBunExecutable(execPath) ? [argv[1], "__host"] : ["__host"];
}
