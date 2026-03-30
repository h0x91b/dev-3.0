import { Utils } from "electrobun/bun";
import { createLogger, getLogPath } from "./logger";

const log = createLogger("menu-actions");

export function openLogsDirectory(openPath: (path: string) => void = Utils.openPath): string {
	const logsPath = getLogPath();
	log.info("Opening logs directory", { path: logsPath });
	openPath(logsPath);
	return logsPath;
}
