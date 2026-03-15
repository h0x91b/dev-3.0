import type { Project, TaskStatus } from "../../shared/types";
import type { TFunction } from "../i18n";
import { statusKey } from "../i18n";

/**
 * Returns the display label for a built-in status, preferring the project's
 * custom label over the default i18n translation.
 */
export function getStatusLabel(
	status: TaskStatus,
	t: TFunction,
	project?: Pick<Project, "customStatusLabels"> | null,
): string {
	const custom = project?.customStatusLabels?.[status];
	if (custom) return custom;
	return t(statusKey(status));
}
